/**
 * In-memory copy of `bot_bans`, so the ban gate never hits the database on every command or click.
 * Filled at boot (`loadBotBans`) and kept in sync by `banFromBot`/`unbanFromBot`. This module is in
 * the hot-reload keep-alive list (cog-loader.ts) so a `/bot reload` doesn't empty it - keep it
 * import-free so nothing it holds goes stale.
 */
import type { BotBanRow } from "../../database/bot-moderation.repository";

const bans = new Map<string, BotBanRow>();

export function setCachedBans(rows: BotBanRow[]): void {
    bans.clear();
    for (const row of rows) bans.set(row.discord_user_id, row);
}

export function cacheBan(row: BotBanRow): void {
    bans.set(row.discord_user_id, row);
}

export function uncacheBan(discordUserId: string): void {
    bans.delete(discordUserId);
}

export function cachedBan(discordUserId: string): BotBanRow | null {
    return bans.get(discordUserId) ?? null;
}
