import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { SessionRecord } from "../types.js";

type ArtifactRecord = {
  id: string;
  sessionId?: string;
  sessionPublicId?: string;
  botId: string;
  chatId: string;
  kind: string;
  path: string;
  fileName?: string;
  mimeType?: string;
  size?: number;
  createdAt: string;
  keep?: boolean;
};

type SecretRecord = {
  key: string;
  value: string;
  createdAt: string;
  updatedAt: string;
};

type DocumentPin = {
  keyword: string;
  targetPath: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
};

type AttemptsState = {
  progress: Record<string, { count: number; lastAt: string; sample: string }>;
};

const MAX_CONTEXT_CHARS = 2500;

export class AgentMemoryService {
  private readonly rootDir: string;
  private readonly artifactsPath: string;
  private readonly secretsPath: string;
  private readonly docsPath: string;

  constructor(private readonly dataDir: string) {
    this.rootDir = path.join(dataDir, "managed");
    this.artifactsPath = path.join(this.rootDir, "artifacts.json");
    this.secretsPath = path.join(this.rootDir, "secrets.json");
    this.docsPath = path.join(this.rootDir, "docs-index.json");
  }

  async recordInstruction(session: SessionRecord, instruction: string): Promise<void> {
    const dir = this.sessionDir(session);
    await fs.mkdir(dir, { recursive: true });
    const currentPath = path.join(dir, "current.md");
    const now = new Date().toISOString();
    const current = await fs.readFile(currentPath, "utf8").catch(() => "");

    if (current.trim() && !this.looksLikeContinuation(instruction)) {
      await this.appendHistory(session, {
        type: "archived",
        at: now,
        reason: "new-instruction",
        text: this.truncate(current, 4000),
      });
      await this.resetAttempts(session);
    }

    const next = [
      `# Current Task`,
      ``,
      `session: ${session.publicId}`,
      `updatedAt: ${now}`,
      ``,
      `## Instruction`,
      instruction.trim(),
      ``,
      `## Immediate Rule`,
      `Before repeating a prior step, check history/attempts. If the same work repeats 3 times, stop and report the blocker.`,
      ``,
    ].join("\n");
    await fs.writeFile(currentPath, next, "utf8");
    await this.appendHistory(session, { type: "instruction", at: now, text: instruction.trim() });
  }

  async completeTask(session: SessionRecord, summary: string): Promise<void> {
    const dir = this.sessionDir(session);
    const currentPath = path.join(dir, "current.md");
    const current = await fs.readFile(currentPath, "utf8").catch(() => "");
    await this.appendHistory(session, {
      type: "completed",
      at: new Date().toISOString(),
      summary: this.truncate(summary, 2000),
      text: this.truncate(current, 4000),
    });
    await fs.rm(currentPath, { force: true }).catch(() => undefined);
    await this.resetAttempts(session);
  }

  async recordProgress(session: SessionRecord, text: string): Promise<{ count: number; repeated: boolean }> {
    const attempts = await this.readAttempts(session);
    const signature = this.progressSignature(text);
    const now = new Date().toISOString();
    const previous = attempts.progress[signature];
    const count = (previous?.count ?? 0) + 1;
    attempts.progress[signature] = {
      count,
      lastAt: now,
      sample: this.truncate(text, 500),
    };
    await this.writeAttempts(session, attempts);
    await this.appendHistory(session, { type: "progress", at: now, count, signature, text: this.truncate(text, 1000) });
    return { count, repeated: count >= 3 };
  }

  async recordArtifact(input: {
    session?: SessionRecord;
    botId: string;
    chatId: string;
    kind: string;
    filePath: string;
    fileName?: string;
    mimeType?: string;
  }): Promise<ArtifactRecord> {
    const artifacts = await this.readJson<ArtifactRecord[]>(this.artifactsPath, []);
    const stat = await fs.stat(input.filePath).catch(() => undefined);
    const existing = artifacts.find((artifact) => artifact.path === input.filePath);
    if (existing) {
      return existing;
    }
    const artifact: ArtifactRecord = {
      id: randomUUID().slice(0, 8),
      sessionId: input.session?.sessionId,
      sessionPublicId: input.session?.publicId,
      botId: input.botId,
      chatId: input.chatId,
      kind: input.kind,
      path: input.filePath,
      fileName: input.fileName,
      mimeType: input.mimeType,
      size: stat?.size,
      createdAt: new Date().toISOString(),
    };
    artifacts.push(artifact);
    await this.writeJson(this.artifactsPath, artifacts);
    return artifact;
  }

  async listArtifacts(session?: SessionRecord, limit = 20): Promise<string> {
    const artifacts = await this.readJson<ArtifactRecord[]>(this.artifactsPath, []);
    const filtered = session
      ? artifacts.filter((artifact) => artifact.sessionId === session.sessionId || artifact.sessionPublicId === session.publicId)
      : artifacts;
    const recent = filtered.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
    if (recent.length === 0) {
      return "No artifacts are indexed yet.";
    }
    return [
      `Artifacts (${recent.length}/${filtered.length})`,
      ...recent.map((artifact, index) => [
        `${index + 1}. ${artifact.id} ${artifact.kind}`,
        `   file: ${artifact.fileName ?? path.basename(artifact.path)}`,
        `   session: ${artifact.sessionPublicId ?? "unknown"}`,
        `   size: ${artifact.size ?? "unknown"} bytes`,
        `   path: ${artifact.path}`,
      ].join("\n")),
    ].join("\n");
  }

  async cleanupArtifacts(days: number): Promise<string> {
    const artifacts = await this.readJson<ArtifactRecord[]>(this.artifactsPath, []);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const kept: ArtifactRecord[] = [];
    let removedFiles = 0;
    let removedRecords = 0;

    for (const artifact of artifacts) {
      const created = Date.parse(artifact.createdAt);
      if (artifact.keep || !Number.isFinite(created) || created >= cutoff) {
        kept.push(artifact);
        continue;
      }
      await fs.rm(artifact.path, { force: true }).then(() => {
        removedFiles += 1;
      }).catch(() => undefined);
      removedRecords += 1;
    }

    await this.writeJson(this.artifactsPath, kept);
    return `Artifact cleanup finished. removedRecords=${removedRecords}, removedFiles=${removedFiles}, kept=${kept.length}`;
  }

  async setSecret(key: string, value: string): Promise<void> {
    this.assertSecretKey(key);
    const secrets = await this.readSecrets();
    const now = new Date().toISOString();
    secrets[key] = {
      key,
      value,
      createdAt: secrets[key]?.createdAt ?? now,
      updatedAt: now,
    };
    await this.writeSecrets(secrets);
  }

  async removeSecret(key: string): Promise<boolean> {
    this.assertSecretKey(key);
    const secrets = await this.readSecrets();
    const existed = Boolean(secrets[key]);
    delete secrets[key];
    await this.writeSecrets(secrets);
    return existed;
  }

  async getSecret(key: string): Promise<string | undefined> {
    this.assertSecretKey(key);
    const secrets = await this.readSecrets();
    return secrets[key]?.value;
  }

  async listSecrets(): Promise<string> {
    const secrets = await this.readSecrets();
    const records = Object.values(secrets).sort((a, b) => a.key.localeCompare(b.key));
    if (records.length === 0) {
      return "No secrets are stored.";
    }
    return [
      `Secrets (${records.length})`,
      ...records.map((secret) => `- ${secret.key} updatedAt=${secret.updatedAt}`),
      "",
      "Values are not shown. Providers may read them through REMOTEAGENT_SECRET_BIN.",
    ].join("\n");
  }

  async pinDocument(keyword: string, targetPath: string, note?: string): Promise<void> {
    const normalized = this.normalizeKeyword(keyword);
    const docs = await this.readDocs();
    const now = new Date().toISOString();
    docs[normalized] = {
      keyword: normalized,
      targetPath,
      note,
      createdAt: docs[normalized]?.createdAt ?? now,
      updatedAt: now,
    };
    await this.writeJson(this.docsPath, docs);
  }

  async removeDocumentPin(keyword: string): Promise<boolean> {
    const normalized = this.normalizeKeyword(keyword);
    const docs = await this.readDocs();
    const existed = Boolean(docs[normalized]);
    delete docs[normalized];
    await this.writeJson(this.docsPath, docs);
    return existed;
  }

  async findDocuments(keyword: string): Promise<string> {
    const normalized = this.normalizeKeyword(keyword);
    const docs = await this.readDocs();
    const matches = Object.values(docs)
      .filter((doc) => doc.keyword.includes(normalized) || normalized.includes(doc.keyword))
      .sort((a, b) => a.keyword.localeCompare(b.keyword));
    if (matches.length === 0) {
      return `No document pins matched: ${keyword}`;
    }
    return [
      `Document pins for "${keyword}" (${matches.length})`,
      ...matches.map((doc) => `- ${doc.keyword}: ${doc.targetPath}${doc.note ? ` (${doc.note})` : ""}`),
    ].join("\n");
  }

  async listDocuments(): Promise<string> {
    const docs = await this.readDocs();
    const records = Object.values(docs).sort((a, b) => a.keyword.localeCompare(b.keyword));
    if (records.length === 0) {
      return "No document pins are configured.";
    }
    return [
      `Document pins (${records.length})`,
      ...records.map((doc) => `- ${doc.keyword}: ${doc.targetPath}${doc.note ? ` (${doc.note})` : ""}`),
    ].join("\n");
  }

  async formatProviderContext(session: SessionRecord): Promise<string> {
    const current = await fs.readFile(path.join(this.sessionDir(session), "current.md"), "utf8").catch(() => "");
    const docs = Object.values(await this.readDocs()).slice(0, 30);
    const secrets = Object.keys(await this.readSecrets()).sort();
    const artifacts = (await this.readJson<ArtifactRecord[]>(this.artifactsPath, []))
      .filter((artifact) => artifact.sessionId === session.sessionId || artifact.sessionPublicId === session.publicId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 8);

    const lines = [
      "RemoteAgent managed context:",
      current.trim() ? ["Current task ledger:", this.truncate(current.trim(), 900)].join("\n") : undefined,
      docs.length > 0
        ? ["Document index:", ...docs.map((doc) => `- ${doc.keyword}: ${doc.targetPath}${doc.note ? ` (${doc.note})` : ""}`)].join("\n")
        : undefined,
      secrets.length > 0
        ? ["Secret keys available through `node \"$REMOTEAGENT_SECRET_BIN\" get <KEY>`:", ...secrets.map((key) => `- ${key}`)].join("\n")
        : undefined,
      artifacts.length > 0
        ? ["Recent session artifacts:", ...artifacts.map((artifact) => `- ${artifact.id} ${artifact.kind}: ${artifact.path}`)].join("\n")
        : undefined,
    ].filter(Boolean).join("\n\n");

    return this.truncate(lines, MAX_CONTEXT_CHARS);
  }

  private looksLikeContinuation(text: string): boolean {
    return /^(계속|이어|진행|수정|고쳐|해|다시|확인|배포|테스트|continue|go on|resume)\b/i.test(text.trim());
  }

  private progressSignature(text: string): string {
    const normalized = text
      .toLowerCase()
      .replace(/\d{4}-\d{2}-\d{2}[^\s]*/g, "")
      .replace(/\b\d+\b/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240);
    return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  }

  private sessionDir(session: SessionRecord): string {
    return path.join(this.rootDir, "sessions", session.publicId);
  }

  private async appendHistory(session: SessionRecord, entry: Record<string, unknown>): Promise<void> {
    const dir = this.sessionDir(session);
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(path.join(dir, "history.ndjson"), `${JSON.stringify(entry)}\n`, "utf8");
  }

  private async readAttempts(session: SessionRecord): Promise<AttemptsState> {
    return this.readJson<AttemptsState>(path.join(this.sessionDir(session), "attempts.json"), { progress: {} });
  }

  private async writeAttempts(session: SessionRecord, attempts: AttemptsState): Promise<void> {
    await this.writeJson(path.join(this.sessionDir(session), "attempts.json"), attempts);
  }

  private async resetAttempts(session: SessionRecord): Promise<void> {
    await this.writeAttempts(session, { progress: {} });
  }

  private async readSecrets(): Promise<Record<string, SecretRecord>> {
    return this.readJson<Record<string, SecretRecord>>(this.secretsPath, {});
  }

  private async writeSecrets(secrets: Record<string, SecretRecord>): Promise<void> {
    await fs.mkdir(path.dirname(this.secretsPath), { recursive: true });
    await fs.writeFile(this.secretsPath, JSON.stringify(secrets, null, 2), { encoding: "utf8", mode: 0o600 });
    await fs.chmod(this.secretsPath, 0o600).catch(() => undefined);
  }

  private async readDocs(): Promise<Record<string, DocumentPin>> {
    return this.readJson<Record<string, DocumentPin>>(this.docsPath, {});
  }

  private normalizeKeyword(keyword: string): string {
    const normalized = keyword.trim().toLowerCase();
    if (!/^[a-z0-9가-힣._-]{1,80}$/i.test(normalized)) {
      throw new Error("Keyword must be 1-80 chars and may contain letters, numbers, Korean, dot, underscore, or dash.");
    }
    return normalized;
  }

  private assertSecretKey(key: string): void {
    if (!/^[A-Z0-9_.-]{1,80}$/.test(key)) {
      throw new Error("Secret key must be 1-80 chars using A-Z, 0-9, dot, underscore, or dash.");
    }
  }

  private async readJson<T>(filePath: string, fallback: T): Promise<T> {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  private async writeJson(filePath: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  private truncate(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max)}\n[truncated ${text.length - max} chars]` : text;
  }
}

export function readSecretValue(dataDir: string, key: string): string | undefined {
  if (!/^[A-Z0-9_.-]{1,80}$/.test(key)) {
    return undefined;
  }
  const filePath = path.join(dataDir, "managed", "secrets.json");
  try {
    const raw = fsSync.readFileSync(filePath, "utf8");
    const secrets = JSON.parse(raw) as Record<string, SecretRecord>;
    return secrets[key]?.value;
  } catch {
    return undefined;
  }
}
