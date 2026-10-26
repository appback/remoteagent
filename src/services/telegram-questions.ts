import { randomUUID } from "node:crypto";

export type AgentQuestion = { question: string; options: string[] };
type PendingQuestion = AgentQuestion & {
  id: string; botId: string; chatId: string; sessionId: string; expiresAt: number;
};

// Only an explicit envelope is actionable; ordinary prose is never classified.
export function parseAgentQuestion(text: string): AgentQuestion | undefined {
  const marker = /^TELEGRAM_QUESTION: (.+)$/m.exec(text);
  if (!marker) return undefined;
  try {
    const value = JSON.parse(marker[1]!) as AgentQuestion;
    if (typeof value.question !== "string" || !value.question.trim() || value.question.length > 2000
      || !Array.isArray(value.options) || value.options.length < 2 || value.options.length > 5
      || value.options.some(x => typeof x !== "string" || !x.trim() || x.length > 80)
      || new Set(value.options).size !== value.options.length) return undefined;
    return { question: value.question, options: value.options };
  } catch { return undefined; }
}

export class TelegramQuestions {
  private readonly pending = new Map<string, PendingQuestion>();
  constructor(private readonly now = Date.now) {}
  clear(botId: string, chatId: string): void {
    for (const [id, q] of this.pending) {
      if (q.expiresAt <= this.now() || (q.botId === botId && q.chatId === chatId)) this.pending.delete(id);
    }
  }
  create(botId: string, chatId: string, sessionId: string, question: AgentQuestion): PendingQuestion {
    this.clear(botId, chatId);
    while (this.pending.size >= 1000) this.pending.delete(this.pending.keys().next().value!);
    const q = { ...question, id: randomUUID().replace(/-/g, ""), botId, chatId, sessionId,
      expiresAt: this.now() + 6 * 60 * 60 * 1000 };
    this.pending.set(q.id, q);
    return q;
  }
  take(id: string, botId: string, chatId: string, sessionId: string, choice: number): PendingQuestion | undefined {
    const q = this.pending.get(id);
    if (!q || q.expiresAt <= this.now() || q.botId !== botId || q.chatId !== chatId
      || q.sessionId !== sessionId || !Number.isInteger(choice) || choice < 0 || choice > q.options.length) return undefined;
    this.pending.delete(id);
    return q;
  }
}

export const telegramQuestions = new TelegramQuestions();
