import type { UserFromGetMe } from "grammy/types";

export function buildBotInfoFromIdentity(id: number, username: string, firstName?: string): UserFromGetMe {
  return {
    id,
    is_bot: true,
    first_name: firstName || username,
    username,
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  } as UserFromGetMe;
}

export function buildFallbackBotInfo(
  token: string,
  index: number,
  configuredUsername?: string,
): UserFromGetMe {
  const id = Number.parseInt(token.split(":", 1)[0] ?? "", 10);
  const persistedUsername = configuredUsername?.trim().replace(/^@/, "");
  const username = persistedUsername
    || knownBotUsername(id)
    || `bot_${Number.isFinite(id) ? id : index + 1}`;

  return {
    id: Number.isFinite(id) ? id : index + 1,
    is_bot: true,
    first_name: username,
    username,
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  } as UserFromGetMe;
}

function knownBotUsername(id: number): string | undefined {
  if (id === 8369496408) {
    return "codex_remoteagent_bot";
  }
  if (id === 8429712341) {
    return "sqream_bot";
  }
  return undefined;
}
