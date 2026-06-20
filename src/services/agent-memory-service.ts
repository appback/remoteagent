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

type TodoStatus = "pending" | "in_progress" | "done" | "blocked";

type TodoItem = {
  id: string;
  text: string;
  status: TodoStatus;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  note?: string;
  workspace?: string;
  memoryPath?: string;
  officialDocs?: string;
  relatedFiles?: string;
  action?: string;
  caution?: string;
  doneEvidence?: string;
  reportFormat?: string;
  stopCondition?: string;
};

type TodoState = {
  createdAt: string;
  updatedAt: string;
  items: TodoItem[];
};

const MAX_CONTEXT_CHARS = 2500;

export class AgentMemoryService {
  private readonly rootDir: string;
  private readonly artifactsPath: string;
  private readonly secretsPath: string;
  private readonly docsPath: string;
  private readonly telegramUploadsDir: string;

  constructor(private readonly dataDir: string) {
    this.rootDir = path.join(dataDir, "managed");
    this.artifactsPath = path.join(this.rootDir, "artifacts.json");
    this.secretsPath = path.join(this.rootDir, "secrets.json");
    this.docsPath = path.join(this.rootDir, "docs-index.json");
    this.telegramUploadsDir = path.join(dataDir, "uploads", "telegram");
  }

  async recordInstruction(session: SessionRecord, instruction: string): Promise<void> {
    const directive = this.extractInstructionDirective(instruction);
    const mode = directive?.kind ?? "message";
    const normalizedInstruction = (directive?.instruction ?? instruction).trim();
    if (!normalizedInstruction) {
      return;
    }
    const dir = this.sessionDir(session);
    await fs.mkdir(dir, { recursive: true });
    const currentPath = path.join(dir, "current.md");
    const now = new Date().toISOString();
    const current = await fs.readFile(currentPath, "utf8").catch(() => "");
    if (current.trim() && mode === "new") {
      await this.appendHistory(session, {
        type: "archived",
        at: now,
        reason: "new-instruction",
        text: this.truncate(current, 4000),
      });
      await this.resetAttempts(session);
    }

    const next = [
      `# Session State`,
      ``,
      `session: ${session.publicId}`,
      `updatedAt: ${now}`,
      ``,
      `## Latest User Instruction`,
      normalizedInstruction.trim(),
      ``,
      `## Harness Rule`,
      `RemoteAgent records this as session state. It must not block provider execution because a TODO is missing.`,
      `Use this state to avoid repeating completed work, reverting prior changes, or losing the current workspace after context compaction.`,
      ``,
    ].join("\n");
    await fs.writeFile(currentPath, next, "utf8");
    await this.appendHistory(session, { type: "instruction", at: now, mode, text: normalizedInstruction.trim() });
  }

  async formatSessionState(session: SessionRecord): Promise<string> {
    const current = await this.currentTaskText(session);
    const todo = await this.readTodo(session);
    const active = this.activeTodoItems(todo);
    const history = await this.readRecentHistory(session, 6);
    return [
      `Session state for ${session.publicId}`,
      "",
      current.trim() ? `Current note:\n${this.summarizeCurrentTask(current)}` : "Current note: none",
      "",
      todo.items.length > 0 ? `Legacy TODO notes:\n${this.formatTodoSummary(todo, true)}` : undefined,
      active.length > 0 ? `legacyActiveTodo: yes` : undefined,
      history.length > 0 ? ["Recent history:", ...history.map((entry) => `- ${entry}`)].join("\n") : undefined,
    ].filter(Boolean).join("\n");
  }

  async formatLocalStatusQuestion(session: SessionRecord, question: string): Promise<string | undefined> {
    if (!this.looksLikeLocalStatusQuestion(question)) {
      return undefined;
    }

    const current = await this.currentTaskText(session);
    const todo = await this.readTodo(session);
    const active = this.activeTodoItems(todo);
    const history = await this.readRecentHistory(session, 8);
    const workHistory = await this.readRecentWorkHistory(session, 6);
    const latestInstruction = this.extractLatestInstructionFromCurrent(current);
    const currentIsStatusOnly = latestInstruction ? this.looksLikeLocalStatusQuestion(latestInstruction) : false;
    const hasCurrentWork = Boolean(current.trim()) && !currentIsStatusOnly;

    const lines = [
      `Session ${session.publicId} local state`,
      "",
      `workspace: ${session.workspace}`,
      `memory: ${this.sessionDir(session)}`,
      "",
    ];

    if (!hasCurrentWork && active.length === 0 && workHistory.length === 0) {
      lines.push(
        "현재 하네스 기준으로 진행 중이거나 완료된 작업 기록이 없습니다.",
        "이 세션은 깨끗한 상태로 보입니다.",
      );
    } else {
      if (hasCurrentWork) {
        lines.push("Current note:", this.summarizeCurrentTask(current), "");
      } else {
        lines.push("Current note: none", "");
      }

      if (active.length > 0) {
        lines.push("Active TODO:", this.formatTodoSummary(todo, false), "");
      } else {
        lines.push("Active TODO: none", "");
      }

      if (workHistory.length > 0) {
        lines.push("Recent work history:", ...workHistory.map((entry) => `- ${entry}`));
      } else {
        lines.push("Recent work history: none");
      }
    }

    if (history.length > 0) {
      lines.push("", "Recent raw history:", ...history.map((entry) => `- ${entry}`));
    }

    return lines.join("\n");
  }

  async clearSessionState(session: SessionRecord, summary: string): Promise<void> {
    const dir = this.sessionDir(session);
    const currentPath = path.join(dir, "current.md");
    const current = await fs.readFile(currentPath, "utf8").catch(() => "");
    const todo = await this.readTodo(session);
    const now = new Date().toISOString();
    if (todo.items.length > 0) {
      await this.writeTodo(session, {
        ...todo,
        updatedAt: now,
        items: todo.items.map((item) => this.isActiveTodo(item)
          ? { ...item, status: "done", updatedAt: now, note: this.truncate(summary, 500) }
          : item),
      });
    }
    await this.appendHistory(session, {
      type: "completed",
      at: now,
      summary: this.truncate(summary, 2000),
      text: this.truncate(current, 4000),
    });
    await fs.rm(currentPath, { force: true }).catch(() => undefined);
    await this.resetAttempts(session);
  }

  async completeTask(session: SessionRecord, summary: string): Promise<void> {
    await this.clearSessionState(session, summary);
  }

  async addSessionNote(session: SessionRecord, note: string): Promise<void> {
    const normalized = note.trim();
    if (!normalized) {
      return;
    }
    const dir = this.sessionDir(session);
    await fs.mkdir(dir, { recursive: true });
    const now = new Date().toISOString();
    await this.appendHistory(session, { type: "note", at: now, text: this.truncate(normalized, 2000) });
    const currentPath = path.join(dir, "current.md");
    const current = await fs.readFile(currentPath, "utf8").catch(() => "");
    const next = [
      current.trim() || [
        "# Session State",
        "",
        `session: ${session.publicId}`,
        `updatedAt: ${now}`,
      ].join("\n"),
      "",
      "## Operator Note",
      normalized,
      "",
    ].join("\n");
    await fs.writeFile(currentPath, next, "utf8");
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
    if (count >= 3) {
      await this.markActiveTodoBlocked(session, `Repeated similar progress report ${count} times.`);
    } else {
      await this.touchActiveTodo(session);
    }
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
    const keptPaths = new Set<string>();
    let removedFiles = 0;
    let removedRecords = 0;

    for (const artifact of artifacts) {
      const created = Date.parse(artifact.createdAt);
      if (artifact.keep || !Number.isFinite(created) || created >= cutoff) {
        kept.push(artifact);
        keptPaths.add(path.resolve(artifact.path));
        continue;
      }
      await fs.rm(artifact.path, { force: true }).then(() => {
        removedFiles += 1;
      }).catch(() => undefined);
      removedRecords += 1;
    }

    await this.writeJson(this.artifactsPath, kept);
    const orphanResult = await this.cleanupOrphanTelegramUploads(cutoff, keptPaths);
    return [
      "Artifact cleanup finished.",
      `removedRecords=${removedRecords}`,
      `removedIndexedFiles=${removedFiles}`,
      `removedOrphanFiles=${orphanResult.removedFiles}`,
      `scannedUploadFiles=${orphanResult.scannedFiles}`,
      `kept=${kept.length}`,
    ].join(" ");
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
    const todo = await this.readTodo(session);
    const history = await this.readRecentHistory(session, 5);
    const docs = Object.values(await this.readDocs()).slice(0, 30);
    const secrets = Object.keys(await this.readSecrets()).sort();
    const artifacts = (await this.readJson<ArtifactRecord[]>(this.artifactsPath, []))
      .filter((artifact) => artifact.sessionId === session.sessionId || artifact.sessionPublicId === session.publicId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 8);

    const lines = [
      "RemoteAgent managed context:",
      [
        "Session work locations:",
        `- workspace: ${session.workspace}`,
        `- memory: ${this.sessionDir(session)}`,
        "- docs: use managed document pins first, then inspect docs/ under the workspace when relevant.",
      ].join("\n"),
      [
        "Harness execution rules:",
        "- Treat the user message as the active instruction unless the user explicitly says otherwise.",
        "- RemoteAgent state is guidance only; never refuse work because a TODO is missing.",
        "- Use the workspace/memory/docs pointers before searching broadly.",
        "- Do not claim external delivery, dashboard access, deployment, or file transfer without concrete evidence.",
        "- RemoteAgent sends normal provider text and TELEGRAM_FILE attachments to the current incoming chat.",
        "- Product/service Telegram notifications belong to product code and should use the project's secret/config path. Never print tokens.",
        "- If the same action or progress repeats 3 times, stop, mark the blocker, and report the exact blocker.",
        "- A final report must include concrete evidence: changed files, relevant line references, git diff/status, command output, or log path.",
      ].join("\n"),
      todo.items.length > 0
        ? ["Legacy task notes:", this.formatTodoSummary(todo, true, true)].join("\n")
        : undefined,
      current.trim() ? ["Current task note:", this.truncate(current.trim(), 700)].join("\n") : undefined,
      history.length > 0 ? ["Recent session history:", ...history.map((entry) => `- ${entry}`)].join("\n") : undefined,
      docs.length > 0
        ? ["Document index:", ...docs.map((doc) => `- ${doc.keyword}: ${doc.targetPath}${doc.note ? ` (${doc.note})` : ""}`)].join("\n")
        : undefined,
      secrets.length > 0
        ? [
            "Secret keys available through `node \"$REMOTEAGENT_SECRET_BIN\" get <KEY>`:",
            ...secrets.map((key) => `- ${key}`),
            "If you generate a new secret value such as an OAuth refresh token, store it without printing it:",
            "`printf '%s' \"$VALUE\" | node \"$REMOTEAGENT_SECRET_BIN\" set <KEY>`",
          ].join("\n")
        : [
            "Secrets can be stored without printing values:",
            "`printf '%s' \"$VALUE\" | node \"$REMOTEAGENT_SECRET_BIN\" set <KEY>`",
          ].join("\n"),
      artifacts.length > 0
        ? ["Recent session artifacts:", ...artifacts.map((artifact) => `- ${artifact.id} ${artifact.kind}: ${artifact.path}`)].join("\n")
        : undefined,
    ].filter(Boolean).join("\n\n");

    return this.truncate(lines, MAX_CONTEXT_CHARS);
  }

  private async currentTaskText(session: SessionRecord): Promise<string> {
    return fs.readFile(path.join(this.sessionDir(session), "current.md"), "utf8").catch(() => "");
  }

  private async readRecentHistory(session: SessionRecord, limit: number): Promise<string[]> {
    return (await this.readHistoryEntries(session, limit))
      .slice(-limit)
      .map((entry) => this.formatHistoryEntry(entry));
  }

  private async readRecentWorkHistory(session: SessionRecord, limit: number): Promise<string[]> {
    return (await this.readHistoryEntries(session, 80))
      .filter((entry) => ["progress", "completed", "archived", "note"].includes(String(entry.type ?? "")))
      .slice(-limit)
      .map((entry) => this.formatHistoryEntry(entry));
  }

  private async readHistoryEntries(session: SessionRecord, limit: number): Promise<Array<Record<string, unknown>>> {
    const historyPath = path.join(this.sessionDir(session), "history.ndjson");
    const raw = await fs.readFile(historyPath, "utf8").catch(() => "");
    return raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return { type: "raw", text: line };
        }
      });
  }

  private formatHistoryEntry(entry: Record<string, unknown>): string {
    const type = typeof entry.type === "string" ? entry.type : "event";
    const mode = typeof entry.mode === "string" ? entry.mode : undefined;
    const at = typeof entry.at === "string" ? entry.at : "unknown";
    const text = typeof entry.text === "string" ? entry.text : "";
    const summary = typeof entry.summary === "string" ? entry.summary : "";
    const reason = typeof entry.reason === "string" ? entry.reason : "";
    const kind = mode ? `${type}:${mode}` : type;
    const body = summary || text || reason || "";
    return `${at} ${kind}: ${this.truncate(body.replace(/\s+/g, " ").trim(), 220)}`;
  }

  private todoPath(session: SessionRecord): string {
    return path.join(this.sessionDir(session), "todo.json");
  }

  private async readTodo(session: SessionRecord): Promise<TodoState> {
    const todo = await this.readJson<TodoState>(this.todoPath(session), { createdAt: "", updatedAt: "", items: [] });
    const normalized = this.normalizeTodoState(todo);
    if (JSON.stringify(normalized) !== JSON.stringify(todo)) {
      await this.writeJson(this.todoPath(session), normalized);
    }
    return normalized;
  }

  private async writeTodo(session: SessionRecord, todo: TodoState): Promise<void> {
    await this.writeJson(this.todoPath(session), {
      ...todo,
      items: this.ensureActiveTodo(todo.items),
    });
  }

  private extractTodoItems(session: SessionRecord, text: string, now: string): TodoItem[] {
    if (!this.looksActionableInstruction(text)) {
      return [];
    }

    const listed = this.extractExplicitTodoLines(text);
    const source = listed.length > 1 ? listed : [text.trim()];
    return source.slice(0, 20).map((item, index) => this.createTodoItem(session, item, index, now));
  }

  private extractExplicitTodoLines(text: string): string[] {
    const shouldSplit = /쪼개|나눠서|단계별|순서대로|체크리스트|todo/i.test(text);
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const listed = lines
      .map((line) => {
        const match = /^([-*]|\d+[.)])\s+(.+)$/.exec(line);
        return match?.[2]?.trim();
      })
      .filter((line): line is string => Boolean(line && line.length >= 4 && this.looksActionableInstruction(line)));
    if (listed.length > 1) {
      return listed;
    }
    if (!shouldSplit) {
      return [];
    }
    return lines
      .map((line) => line.replace(/^[-*]\s+/, "").replace(/^\d+[.)]\s+/, "").trim())
      .filter((line) => line.length >= 4 && this.looksActionableInstruction(line));
  }

  private createTodoItem(session: SessionRecord, text: string, index: number, now: string): TodoItem {
    const purpose = this.truncate(this.normalizeTodoPurpose(text), 500);
    const sessionMemory = this.sessionDir(session);
    return {
      id: `T${String(index + 1).padStart(3, "0")}`,
      text: purpose,
      status: index === 0 ? "in_progress" : "pending",
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      action: this.truncate(text.trim(), 700),
      workspace: index === 0 ? session.workspace : undefined,
      memoryPath: index === 0 ? sessionMemory : undefined,
    };
  }

  private normalizeTodoPurpose(text: string): string {
    const compact = text.replace(/\s+/g, " ").trim();
    const sentence = compact.split(/(?<=[.!?。！？])\s+/u)[0] || compact;
    return sentence;
  }

  private looksActionableInstruction(text: string): boolean {
    const normalized = text.trim();
    if (!normalized) {
      return false;
    }
    if (/너는\s+.+담당|담당이야|역할은|프로젝트는/i.test(normalized) && !/개발|진행|등록|처리|시작|작업|수정|고쳐|구현|추가|저장|기록|남겨|배포|테스트|검증|실패|에러|버그|문제|postback|로그|히스토리|마이그레이션|근거|참조|산출물|확인/i.test(normalized)) {
      return false;
    }
    return /개발|진행|등록|처리|시작|작업|구축|연동|작성|수정|고쳐|구현|추가|저장|기록|남겨|배포|테스트|검증|확인|찾아|분석|비교|참조|근거|이유|왜|어떤|어디|어떻게|산출물|자료|데이터|출처|실패|에러|버그|문제|DB|database|api|postback|로그|히스토리|마이그레이션|schema|table|endpoint/i.test(normalized);
  }

  private activeTodoItems(todo: TodoState): TodoItem[] {
    return todo.items.filter((item) => this.isActiveTodo(item));
  }

  private isActiveTodo(item: TodoItem): boolean {
    return item.status === "pending" || item.status === "in_progress";
  }

  private ensureActiveTodo(items: TodoItem[]): TodoItem[] {
    const activeIndex = items.findIndex((item) => item.status === "in_progress");
    if (activeIndex >= 0) {
      return items;
    }
    const pendingIndex = items.findIndex((item) => item.status === "pending");
    if (pendingIndex < 0) {
      return items;
    }
    return items.map((item, index) => index === pendingIndex ? { ...item, status: "in_progress" } : item);
  }

  private normalizeTodoState(todo: TodoState): TodoState {
    const now = new Date().toISOString();
    const items = (todo.items ?? []).map((item) => {
      return item;
    });
    return {
      createdAt: todo.createdAt || now,
      updatedAt: todo.updatedAt || now,
      items: this.ensureActiveTodo(items),
    };
  }

  private matchesAnyTodo(text: string, items: TodoItem[]): boolean {
    return items.some((item) => this.todoTextSimilarity(text, item.text) >= 0.86);
  }

  private todoTextSimilarity(left: string, right: string): number {
    const a = this.normalizeComparableText(left);
    const b = this.normalizeComparableText(right);
    if (!a || !b) {
      return 0;
    }
    if (a === b) {
      return 1;
    }
    const shorter = a.length <= b.length ? a : b;
    const longer = a.length > b.length ? a : b;
    if (shorter.length >= 20 && longer.includes(shorter)) {
      return shorter.length / longer.length;
    }
    const aGrams = this.charBigrams(a);
    const bGrams = this.charBigrams(b);
    if (aGrams.size === 0 || bGrams.size === 0) {
      return 0;
    }
    let intersection = 0;
    for (const gram of aGrams) {
      if (bGrams.has(gram)) {
        intersection += 1;
      }
    }
    return intersection / (aGrams.size + bGrams.size - intersection);
  }

  private normalizeComparableText(text: string): string {
    return text
      .toLowerCase()
      .replace(/\s+/g, "")
      .replace(/[^\p{L}\p{N}가-힣]/gu, "")
      .trim();
  }

  private charBigrams(text: string): Set<string> {
    if (text.length <= 1) {
      return new Set(text ? [text] : []);
    }
    const grams = new Set<string>();
    for (let index = 0; index < text.length - 1; index += 1) {
      grams.add(text.slice(index, index + 2));
    }
    return grams;
  }

  private async touchActiveTodo(session: SessionRecord): Promise<void> {
    const todo = await this.readTodo(session);
    const index = todo.items.findIndex((item) => item.status === "in_progress");
    if (index < 0) {
      return;
    }
    const now = new Date().toISOString();
    const items = todo.items.slice();
    items[index] = { ...items[index], attempts: items[index].attempts + 1, updatedAt: now };
    await this.writeTodo(session, { ...todo, updatedAt: now, items });
  }

  private async markActiveTodoBlocked(session: SessionRecord, note: string): Promise<void> {
    const todo = await this.readTodo(session);
    const now = new Date().toISOString();
    await this.writeTodo(session, {
      ...todo,
      updatedAt: now,
      items: todo.items.map((item) => item.status === "in_progress"
        ? { ...item, status: "blocked", updatedAt: now, note }
        : item),
    });
  }

  private extractInstructionDirective(text: string): { kind: "new" | "continue"; instruction: string } | undefined {
    const match = /^(new|새작업|새\s*작업|continue|계속|이어|이어서)\s*[:：]\s*([\s\S]+)$/i.exec(text.trim());
    if (!match) {
      return undefined;
    }
    const raw = match[1]?.toLowerCase().replace(/\s+/g, "") ?? "";
    const instruction = match[2]?.trim() ?? "";
    if (!instruction) {
      return undefined;
    }
    return {
      kind: raw === "new" || raw === "새작업" ? "new" : "continue",
      instruction,
    };
  }

  private looksLikeContinuation(text: string): boolean {
    const normalized = text.trim();
    return /^(계속|이어|이어서|진행|수정|고쳐|해|다시|확인|검증|배포|빌드|테스트|적용|마무리|커밋|푸시|중단|멈춰|결과|상태|됐어|했어|끝났|완료|continue|go on|resume)/i.test(normalized);
  }

  private looksLikeNewTask(text: string): boolean {
    return /^(새로|새\s*작업|다른\s*작업|이제\s*부터|다음\s*작업|전환|바꿔서|new task)/i.test(text.trim());
  }

  private summarizeCurrentTask(current: string): string {
    const latestInstruction = this.extractLatestInstructionFromCurrent(current);
    if (latestInstruction) {
      return this.truncate(latestInstruction, 700);
    }
    const instructionIndex = current.indexOf("## Instruction");
    const body = instructionIndex >= 0 ? current.slice(instructionIndex + "## Instruction".length) : current;
    const immediateRuleIndex = body.indexOf("## Immediate Rule");
    const instruction = (immediateRuleIndex >= 0 ? body.slice(0, immediateRuleIndex) : body).trim();
    return this.truncate(instruction || current.trim(), 700);
  }

  private extractLatestInstructionFromCurrent(current: string): string | undefined {
    const match = /## Latest User Instruction\s*\n([\s\S]*?)(?:\n## |\s*$)/.exec(current);
    return match?.[1]?.trim() || undefined;
  }

  private looksLikeLocalStatusQuestion(text: string): boolean {
    const normalized = text.trim();
    if (!normalized) {
      return false;
    }
    return [
      /최근\s*(작업|진행|히스토리|기록)/,
      /현재\s*(작업|진행|상태|세션)/,
      /(뭐|무엇)\s*(하고|하는)\s*(있어|중|거야)?/,
      /작업\s*(상태|히스토리|기록|있어|없어)/,
      /세션\s*(상태|히스토리|기록)/,
      /진행\s*(상태|중인\s*작업)/,
      /\b(status|current work|recent work|what are you doing|session state)\b/i,
    ].some((pattern) => pattern.test(normalized));
  }

  private formatTodoSummary(todo: TodoState, includeDone = false, detailed = false): string {
    const items = includeDone ? todo.items : todo.items.filter((item) => item.status !== "done");
    if (items.length === 0) {
      return "TODO: none";
    }
    return items.map((item, index) => {
      const marker = item.status === "done" ? "완료" : item.status === "in_progress" ? "진행중" : item.status === "blocked" ? "차단" : "대기";
      const note = item.note ? ` (${item.note})` : "";
      if (!detailed) {
        const attempts = item.attempts > 0 ? ` attempts=${item.attempts}` : "";
        return `${index + 1}. [${item.id}] ${marker}: ${item.text}${note}${attempts}`;
      }
      const details = [
        `${index + 1}. [${item.id}] ${marker}: ${item.text}${note}`,
        item.workspace ? `   - 작업 폴더: ${item.workspace}` : undefined,
        item.memoryPath ? `   - 개인 memory: ${item.memoryPath}` : undefined,
        item.officialDocs ? `   - 공식 문서 위치: ${item.officialDocs}` : undefined,
        item.relatedFiles ? `   - 관련 파일: ${item.relatedFiles}` : undefined,
        item.action ? `   - 해야 할 일: ${item.action}` : undefined,
        item.caution ? `   - 하지 말 것: ${item.caution}` : undefined,
        item.doneEvidence ? `   - 완료 조건: ${item.doneEvidence}` : undefined,
        item.stopCondition ? `   - 중단 조건: ${item.stopCondition}` : undefined,
        item.reportFormat ? `   - 보고 형식: ${item.reportFormat}` : undefined,
        `   - attempts: ${item.attempts}`,
      ].filter(Boolean);
      return details.join("\n");
    }).join("\n");
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

  private async cleanupOrphanTelegramUploads(cutoff: number, keptPaths: Set<string>): Promise<{ scannedFiles: number; removedFiles: number }> {
    let scannedFiles = 0;
    let removedFiles = 0;
    const files = await this.listFilesRecursive(this.telegramUploadsDir);

    for (const filePath of files) {
      scannedFiles += 1;
      const resolved = path.resolve(filePath);
      if (keptPaths.has(resolved)) {
        continue;
      }

      const stat = await fs.stat(filePath).catch(() => undefined);
      if (!stat?.isFile() || stat.mtimeMs >= cutoff) {
        continue;
      }

      await fs.rm(filePath, { force: true }).then(() => {
        removedFiles += 1;
      }).catch(() => undefined);
    }

    await this.removeEmptyDirectories(this.telegramUploadsDir);
    return { scannedFiles, removedFiles };
  }

  private async listFilesRecursive(root: string): Promise<string[]> {
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    const files: string[] = [];

    for (const entry of entries) {
      const entryPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        files.push(...await this.listFilesRecursive(entryPath));
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }

    return files;
  }

  private async removeEmptyDirectories(root: string): Promise<boolean> {
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    let empty = entries.length === 0;

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        empty = false;
        continue;
      }

      const childPath = path.join(root, entry.name);
      const childEmpty = await this.removeEmptyDirectories(childPath);
      if (!childEmpty) {
        empty = false;
      }
    }

    if (empty && root !== this.telegramUploadsDir) {
      await fs.rmdir(root).catch(() => undefined);
    }

    return empty;
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

export function writeSecretValue(dataDir: string, key: string, value: string): void {
  if (!/^[A-Z0-9_.-]{1,80}$/.test(key)) {
    throw new Error("Secret key must be 1-80 chars using A-Z, 0-9, dot, underscore, or dash.");
  }

  const filePath = path.join(dataDir, "managed", "secrets.json");
  fsSync.mkdirSync(path.dirname(filePath), { recursive: true });

  let secrets: Record<string, SecretRecord> = {};
  try {
    const raw = fsSync.readFileSync(filePath, "utf8");
    secrets = JSON.parse(raw) as Record<string, SecretRecord>;
  } catch {
    secrets = {};
  }

  const now = new Date().toISOString();
  secrets[key] = {
    key,
    value,
    createdAt: secrets[key]?.createdAt ?? now,
    updatedAt: now,
  };

  fsSync.writeFileSync(filePath, `${JSON.stringify(secrets, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    fsSync.chmodSync(filePath, 0o600);
  } catch {
    // Best effort only; some platforms do not support chmod.
  }
}
