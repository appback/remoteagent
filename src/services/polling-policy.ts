import type { BotPollingState } from "./bot-polling-state-service.js";

export type PollingPolicyConfig = {
  tieredPollingMinBots: number;
  activePollIntervalMs: number;
  runningPollIntervalMs: number;
  secondaryPollIntervalMs: number;
  tertiaryPollIntervalMs: number;
};

export function computeRecentMessageRanks(
  botIds: string[],
  states: Record<string, BotPollingState>,
): Map<string, number> {
  const ranked = botIds
    .map((botId) => ({
      botId,
      timestamp: parseStateTime(states[botId]?.lastMessageAt)
        ?? parseStateTime(states[botId]?.lastUpdateAt)
        ?? parseStateTime(states[botId]?.lastPollAt)
        ?? 0,
    }))
    .sort((left, right) => right.timestamp - left.timestamp);
  return new Map(ranked.map((entry, index) => [entry.botId, index + 1]));
}

export function computePolicyPollIntervalMs(
  totalBots: number,
  botRank: number,
  state: BotPollingState | undefined,
  policy: PollingPolicyConfig,
): number {
  if (state?.runningSessionIds && state.runningSessionIds.length > 0) {
    return policy.runningPollIntervalMs;
  }
  if (totalBots < policy.tieredPollingMinBots) {
    return policy.activePollIntervalMs;
  }
  if (botRank <= 4) {
    return policy.activePollIntervalMs;
  }
  if (botRank <= 8) {
    return policy.secondaryPollIntervalMs;
  }
  return policy.tertiaryPollIntervalMs;
}

function parseStateTime(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}
