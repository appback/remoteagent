import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const BUNDLE_FORMAT = "remoteagent-secret-bundle";
const BUNDLE_VERSION = 1;
const AAD = Buffer.from(`${BUNDLE_FORMAT}:v${BUNDLE_VERSION}`, "utf8");

type SecretRecord = {
  key: string;
  value: string;
  createdAt: string;
  updatedAt: string;
};

type SecretPayload = {
  exportedAt: string;
  secrets: Record<string, SecretRecord>;
};

type SecretBundle = {
  format: typeof BUNDLE_FORMAT;
  version: typeof BUNDLE_VERSION;
  kdf: {
    name: "scrypt";
    salt: string;
  };
  cipher: {
    name: "aes-256-gcm";
    iv: string;
    tag: string;
  };
  data: string;
};

export type SecretExportResult = {
  outputPath: string;
  count: number;
};

export type SecretImportResult = {
  imported: number;
  overwritten: number;
  total: number;
  backupPath?: string;
};

export async function exportSecrets(dataDir: string, outputPath: string, passphrase: string): Promise<SecretExportResult> {
  assertPassphrase(passphrase);
  const secretsPath = path.join(dataDir, "managed", "secrets.json");
  const secrets = await readSecrets(secretsPath, false);
  const payload: SecretPayload = {
    exportedAt: new Date().toISOString(),
    secrets,
  };
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(AAD);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  const bundle: SecretBundle = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    kdf: {
      name: "scrypt",
      salt: salt.toString("base64"),
    },
    cipher: {
      name: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    },
    data: encrypted.toString("base64"),
  };
  const resolvedOutputPath = path.resolve(outputPath);
  await atomicWrite(resolvedOutputPath, `${JSON.stringify(bundle, null, 2)}\n`, 0o600);
  return {
    outputPath: resolvedOutputPath,
    count: Object.keys(secrets).length,
  };
}

export async function importSecrets(
  dataDir: string,
  inputPath: string,
  passphrase: string,
  replace = false,
): Promise<SecretImportResult> {
  assertPassphrase(passphrase);
  const resolvedInputPath = path.resolve(inputPath);
  const bundle = parseBundle(await fs.readFile(resolvedInputPath, "utf8"));
  const salt = decodeBase64(bundle.kdf.salt, "salt");
  const iv = decodeBase64(bundle.cipher.iv, "iv");
  const tag = decodeBase64(bundle.cipher.tag, "authentication tag");
  const encrypted = decodeBase64(bundle.data, "encrypted data");
  const key = await deriveKey(passphrase, salt);
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch {
    throw new Error("Secret bundle could not be decrypted. Check the passphrase and file integrity.");
  }

  const payload = parsePayload(plaintext.toString("utf8"));
  const secretsPath = path.join(dataDir, "managed", "secrets.json");
  const existing = await readSecrets(secretsPath, true);
  const incomingKeys = Object.keys(payload.secrets);
  const overwritten = incomingKeys.filter((keyName) => Boolean(existing[keyName])).length;
  const merged = replace ? payload.secrets : { ...existing, ...payload.secrets };
  let backupPath: string | undefined;

  if (Object.keys(existing).length > 0) {
    backupPath = `${secretsPath}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await fs.mkdir(path.dirname(backupPath), { recursive: true });
    await fs.copyFile(secretsPath, backupPath);
    await fs.chmod(backupPath, 0o600).catch(() => undefined);
  }

  await atomicWrite(secretsPath, `${JSON.stringify(merged, null, 2)}\n`, 0o600);
  return {
    imported: incomingKeys.length,
    overwritten,
    total: Object.keys(merged).length,
    backupPath,
  };
}

function parseBundle(text: string): SecretBundle {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Secret bundle is not valid JSON.");
  }
  const bundle = value as Partial<SecretBundle>;
  if (
    bundle.format !== BUNDLE_FORMAT
    || bundle.version !== BUNDLE_VERSION
    || bundle.kdf?.name !== "scrypt"
    || bundle.cipher?.name !== "aes-256-gcm"
    || typeof bundle.kdf.salt !== "string"
    || typeof bundle.cipher.iv !== "string"
    || typeof bundle.cipher.tag !== "string"
    || typeof bundle.data !== "string"
  ) {
    throw new Error("Unsupported or malformed RemoteAgent secret bundle.");
  }
  return bundle as SecretBundle;
}

function parsePayload(text: string): SecretPayload {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Decrypted secret payload is invalid.");
  }
  const payload = value as Partial<SecretPayload>;
  if (!payload.secrets || typeof payload.secrets !== "object" || Array.isArray(payload.secrets)) {
    throw new Error("Decrypted secret payload has no valid secret records.");
  }
  validateSecrets(payload.secrets as Record<string, SecretRecord>);
  return payload as SecretPayload;
}

async function readSecrets(filePath: string, missingIsEmpty: boolean): Promise<Record<string, SecretRecord>> {
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (missingIsEmpty) {
        return {};
      }
      throw new Error(`No RemoteAgent secrets were found at ${filePath}.`);
    }
    throw error;
  }

  let secrets: unknown;
  try {
    secrets = JSON.parse(text);
  } catch {
    throw new Error(`RemoteAgent secret store is invalid JSON: ${filePath}`);
  }
  if (!secrets || typeof secrets !== "object" || Array.isArray(secrets)) {
    throw new Error(`RemoteAgent secret store is malformed: ${filePath}`);
  }
  validateSecrets(secrets as Record<string, SecretRecord>);
  return secrets as Record<string, SecretRecord>;
}

function validateSecrets(secrets: Record<string, SecretRecord>): void {
  for (const [key, record] of Object.entries(secrets)) {
    if (
      !/^[A-Z0-9_.-]{1,80}$/.test(key)
      || !record
      || typeof record !== "object"
      || record.key !== key
      || typeof record.value !== "string"
      || typeof record.createdAt !== "string"
      || typeof record.updatedAt !== "string"
    ) {
      throw new Error(`Secret record is malformed: ${key}`);
    }
  }
}

function assertPassphrase(passphrase: string): void {
  if (passphrase.length < 8) {
    throw new Error("Secret bundle passphrase must be at least 8 characters.");
  }
}

function decodeBase64(value: string, label: string): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0) {
    throw new Error(`Secret bundle ${label} is empty or invalid.`);
  }
  return decoded;
}

function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(passphrase, salt, 32, (error, key) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(key as Buffer);
    });
  });
}

async function atomicWrite(filePath: string, content: string, mode: number): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tempPath, content, { encoding: "utf8", mode });
    await fs.chmod(tempPath, mode).catch(() => undefined);
    await fs.rename(tempPath, filePath);
    await fs.chmod(filePath, mode).catch(() => undefined);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}
