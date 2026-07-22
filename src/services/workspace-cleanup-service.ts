import fs from "node:fs/promises";
import path from "node:path";
import type { SessionRecord } from "../types.js";

type CleanupResult = {
  removedPaths: number;
  removedBytes: number;
  skipped: number;
  messages: string[];
};

type BridgeStateShape = {
  sessions?: Record<string, SessionRecord>;
};

const GENERATED_DIR_NAMES = new Set([
  ".cache",
  ".gradle",
  ".next",
  ".nuxt",
  ".parcel-cache",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);

const GENERATED_FILE_PATTERNS = [
  /\.log$/i,
  /\.tmp$/i,
  /\.tsbuildinfo$/i,
  /^npm-debug\.log/i,
  /^pnpm-debug\.log/i,
  /^yarn-error\.log/i,
  /^\.DS_Store$/i,
];

const MAX_SCAN_DEPTH = 5;

export class WorkspaceCleanupService {
  constructor(
    private readonly dataDir: string,
    private readonly workspaceRoot: string,
  ) {}

  async cleanupOrphanWorkspaces(): Promise<string> {
    const referenced = await this.referencedWorkspaceNames();
    const entries = await fs.readdir(this.workspaceRoot, { withFileTypes: true }).catch(() => []);
    const result: CleanupResult = { removedPaths: 0, removedBytes: 0, skipped: 0, messages: [] };

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (referenced.has(entry.name)) {
        continue;
      }

      const target = path.join(this.workspaceRoot, entry.name);
      const bytes = await this.directorySize(target);
      await fs.rm(target, { recursive: true, force: true });
      result.removedPaths += 1;
      result.removedBytes += bytes;
      result.messages.push(`${entry.name} (${formatBytes(bytes)})`);
    }

    return [
      "Workspace orphan cleanup finished.",
      `removed=${result.removedPaths}`,
      `freed=${formatBytes(result.removedBytes)}`,
      result.messages.length > 0 ? `items=${result.messages.join(", ")}` : "items=none",
    ].join(" ");
  }

  async cleanupSessionWorkspace(session: SessionRecord): Promise<string> {
    if (!this.isManagedWorkspace(session.workspace)) {
      return [
        `Workspace cleanup skipped for ${session.publicId}.`,
        "The current workspace is not managed by RemoteAgent.",
        `workspace=${session.workspace}`,
      ].join("\n");
    }

    const result: CleanupResult = { removedPaths: 0, removedBytes: 0, skipped: 0, messages: [] };
    await this.cleanupGeneratedEntries(session.workspace, 0, result);

    return [
      `Workspace cleanup finished for ${session.publicId}.`,
      `workspace=${session.workspace}`,
      `removed=${result.removedPaths}`,
      `freed=${formatBytes(result.removedBytes)}`,
      `skipped=${result.skipped}`,
      result.messages.length > 0
        ? ["removedItems:", ...result.messages.slice(0, 30).map((item) => `- ${item}`)].join("\n")
        : "removedItems: none",
    ].join("\n");
  }

  private async cleanupGeneratedEntries(root: string, depth: number, result: CleanupResult): Promise<void> {
    if (depth > MAX_SCAN_DEPTH) {
      return;
    }

    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const entryPath = path.join(root, entry.name);
      if (entry.name === ".git") {
        result.skipped += 1;
        continue;
      }

      if (entry.isDirectory()) {
        if (GENERATED_DIR_NAMES.has(entry.name)) {
          await this.removePath(entryPath, result);
          continue;
        }
        await this.cleanupGeneratedEntries(entryPath, depth + 1, result);
        continue;
      }

      if (entry.isFile() && GENERATED_FILE_PATTERNS.some((pattern) => pattern.test(entry.name))) {
        await this.removePath(entryPath, result);
      }
    }
  }

  private async removePath(target: string, result: CleanupResult): Promise<void> {
    const bytes = await this.pathSize(target);
    await fs.rm(target, { recursive: true, force: true });
    result.removedPaths += 1;
    result.removedBytes += bytes;
    result.messages.push(`${path.relative(this.workspaceRoot, target)} (${formatBytes(bytes)})`);
  }

  private async referencedWorkspaceNames(): Promise<Set<string>> {
    const state = await this.readState();
    const referenced = new Set<string>();
    const root = path.resolve(this.workspaceRoot);

    for (const session of Object.values(state.sessions ?? {})) {
      const workspace = session.workspace ? path.resolve(session.workspace) : "";
      if (!workspace || !this.isPathInside(root, workspace)) {
        continue;
      }
      referenced.add(path.basename(workspace));
    }

    return referenced;
  }

  private async readState(): Promise<BridgeStateShape> {
    const statePath = path.join(this.dataDir, "state.json");
    const raw = await fs.readFile(statePath, "utf8").catch((error: NodeJS.ErrnoException) => {
      throw new Error(`state unavailable, refusing workspace cleanup: ${error.message}`);
    });
    const parsed = JSON.parse(raw) as BridgeStateShape;
    if (!parsed || typeof parsed !== "object" || !parsed.sessions || typeof parsed.sessions !== "object") {
      throw new Error(`state unavailable, refusing workspace cleanup: invalid state at ${statePath}`);
    }
    return parsed;
  }

  private isManagedWorkspace(workspace: string): boolean {
    const root = path.resolve(this.workspaceRoot);
    const resolved = path.resolve(workspace);
    return this.isPathInside(root, resolved) && resolved !== root;
  }

  private isPathInside(parent: string, child: string): boolean {
    const relative = path.relative(parent, child);
    return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
  }

  private async pathSize(target: string): Promise<number> {
    const stat = await fs.stat(target).catch(() => undefined);
    if (!stat) {
      return 0;
    }
    if (stat.isFile()) {
      return stat.size;
    }
    if (stat.isDirectory()) {
      return this.directorySize(target);
    }
    return 0;
  }

  private async directorySize(directory: string): Promise<number> {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    let total = 0;
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      const stat = await fs.stat(entryPath).catch(() => undefined);
      if (!stat) {
        continue;
      }
      if (stat.isFile()) {
        total += stat.size;
      } else if (stat.isDirectory()) {
        total += await this.directorySize(entryPath);
      }
    }
    return total;
  }
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)}${units[unitIndex]}`;
}
