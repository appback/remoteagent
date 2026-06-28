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
      timestamp: latestTimestamp(
        states[botId]?.lastUserMessageAt ?? states[botId]?.lastMessageAt,
        states[botId]?.lastProviderCompletedAt,
      ),
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

function latestTimestamp(...values: Array<string | undefined>): number {
  return Math.max(0, ...values.map((value) => parseStateTime(value) ?? 0));
}
