export const ASTRA_REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AstraReasoning = typeof ASTRA_REASONING_LEVELS[number];

export function supportsCodexReasoning(model: string | undefined): boolean {
  return model === "gpt-6-astra" || model === "gpt-6.1-sol";
}

export function isAstraReasoning(value: string): value is AstraReasoning {
  return (ASTRA_REASONING_LEVELS as readonly string[]).includes(value);
}

export function getAstraReasoning(): AstraReasoning {
  const value = process.env.CODEX_REASONING_EFFORT ?? "medium";
  return isAstraReasoning(value) ? value : "medium";
}
