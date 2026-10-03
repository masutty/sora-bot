/**
 * The bot-wide ban gate: a user banned with `/bot ban` can't run any command or use any component
 * of the bot - every attempt is answered with this error instead. Checked by the command dispatcher
 * and the component router, before anything else runs. Reads the in-memory ban cache only.
 */
import { config } from "@/config";
import { type BotBanRow, deleteBotBan, getAllBotBans, insertBotBan, insertBotPunishment } from "@/database/bot-moderation.repository";
import { EmbedFormatter, type FormattedReply } from "@/utils/format";
import { Logger } from "@/utils/logging";
import { UserFacingError } from "../command/user-facing-error";
import { cacheBan, cachedBan, setCachedBans, uncacheBan } from "./bot-ban-cache";

const logger = new Logger("core.moderation");

export interface BotBanGateDeps {
    getBotBan: (discordUserId: string) => BotBanRow | null | Promise<BotBanRow | null>;
    ownerIds: () => readonly string[];
}

export function defaultBotBanGateDeps(): BotBanGateDeps {
    return { getBotBan: cachedBan, ownerIds: () => config.bot.ownerIds };
}

export function buildBannedReply(ban: Pick<BotBanRow, "reason">): FormattedReply {
    const reason = ban.reason ? `\nReason: ${ban.reason}` : "";
    return EmbedFormatter.error(`You are banned from using this bot.${reason}`);
}

/**
 * The error reply for a banned user, or `null` to let them through. Bot owners are never blocked
 * (no locking yourself out). If the lookup itself fails, the user is let through and it's logged -
 * a hiccup must not take every command down with it.
 */
export async function botBanReply(discordUserId: string, deps: BotBanGateDeps = defaultBotBanGateDeps()): Promise<FormattedReply | null> {
    if (deps.ownerIds().includes(discordUserId)) return null;
    try {
        const ban = await deps.getBotBan(discordUserId);
        return ban ? buildBannedReply(ban) : null;
    } catch (err) {
        logger.warn(`Bot ban lookup failed for ${discordUserId} - letting them through`, {
            error: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}

/** Fills the ban cache from the database - at boot, before any command can run. */
export async function loadBotBans(): Promise<void> {
    const rows = await getAllBotBans();
    setCachedBans(rows);
    logger.info(`Loaded ${rows.length} bot ban(s).`);
}

/** Everything ban/unban would otherwise call on the database, injected so tests never touch it. */
export interface BotModerationDeps {
    insertBotBan: typeof insertBotBan;
    deleteBotBan: typeof deleteBotBan;
    insertBotPunishment: typeof insertBotPunishment;
    ownerIds: () => readonly string[];
}

export function defaultBotModerationDeps(): BotModerationDeps {
    return { insertBotBan, deleteBotBan, insertBotPunishment, ownerIds: () => config.bot.ownerIds };
}

/** Bans a user from the whole bot and records it in their history. `false` if they were already banned. */
export async function banFromBot(
    discordUserId: string,
    reason: string | null,
    byUserId: string,
    deps: BotModerationDeps = defaultBotModerationDeps(),
): Promise<boolean> {
    if (deps.ownerIds().includes(discordUserId)) throw new UserFacingError("You can't ban a bot owner.");
    if (!(await deps.insertBotBan(discordUserId, reason, byUserId))) return false;
    await deps.insertBotPunishment(discordUserId, "ban", reason, byUserId);
    cacheBan({ discord_user_id: discordUserId, reason, banned_by: byUserId, created_at: new Date() });
    return true;
}

/** Lifts a user's bot ban and records it in their history. `false` if they weren't banned. */
export async function unbanFromBot(
    discordUserId: string,
    byUserId: string,
    deps: BotModerationDeps = defaultBotModerationDeps(),
): Promise<boolean> {
    if (!(await deps.deleteBotBan(discordUserId))) return false;
    await deps.insertBotPunishment(discordUserId, "unban", null, byUserId);
    uncacheBan(discordUserId);
    return true;
}
