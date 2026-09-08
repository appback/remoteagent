export const ASTRA_REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AstraReasoning = typeof ASTRA_REASONING_LEVELS[number];

export function isAstraReasoning(value: string): value is AstraReasoning {
  return (ASTRA_REASONING_LEVELS as readonly string[]).includes(value);
}

export function getAstraReasoning(): AstraReasoning {
  const value = process.env.CODEX_REASONING_EFFORT ?? "medium";
  return isAstraReasoning(value) ? value : "medium";
}
