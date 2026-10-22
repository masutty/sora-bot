import { DiscordAPIError, type MessageCreateOptions } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { Logger } from "@/utils/logging";
import * as badgesRepo from "../repository/badges.repository";
import { clearTrackerChannelIf } from "../repository/guilds.repository";
import { getAllFanoutRows, getFanoutRowsForBadge } from "../repository/subscriptions.repository";
import { settings } from "../settings";
import type { BadgeRow, FanoutRow } from "../types";
import { buildAwardPost, buildDeletedPost, resolveDescription } from "../views/award-post";
import { evaluateCheck } from "./award-delta";
import { type PostStatus, postStatus, roleExists } from "./post-status";
import { createRobloxClient, type RobloxClient } from "./roblox.client";

const logger = new Logger("badge-tracker.poller");

export type SendResult = "sent" | "unknown_channel" | "forbidden" | "failed";

export interface PollerDeps {
    roblox: RobloxClient;
    now(): Date;
    sleep(ms: number): Promise<void>;
    intervalMs: number;
    postStatus(guildId: string, channelId: string | null): PostStatus;
    roleExists(guildId: string, roleId: string): boolean;
    send(channelId: string, payload: MessageCreateOptions): Promise<SendResult>;
    repo: Pick<
        typeof badgesRepo,
        "getBadges" | "recordCheck" | "updateBadgeMeta" | "clearBaselines" | "incrementNotFound" | "markDeleted"
    > & {
        getAllFanoutRows(): Promise<FanoutRow[]>;
        getFanoutRowsForBadge(badgeId: string): Promise<FanoutRow[]>;
        clearTrackerChannelIf(guildId: string, channelId: string): Promise<void>;
    };
}

export type RoundResult = { kind: "done"; checked: number } | { kind: "rate_limited"; retryAfterMs: number | null };

/** Reads every live Badge once and fans positive deltas out to each live Subscription. */
export async function runRound(deps: PollerDeps): Promise<RoundResult> {
    const { repo } = deps;

    // Subscriptions that can receive posts, grouped by Badge (insertion order = polling order).
    const statusByGuild = new Map<string, PostStatus>();
    const liveSubs = new Map<string, FanoutRow[]>();
    for (const row of await repo.getAllFanoutRows()) {
        let status = statusByGuild.get(row.guild_id);
        if (status === undefined) {
            status = deps.postStatus(row.guild_id, row.channel_id);
            statusByGuild.set(row.guild_id, status);
            if (status === "channel_missing" && row.channel_id) await repo.clearTrackerChannelIf(row.guild_id, row.channel_id);
        }
        if (status !== "ok") continue;
        const list = liveSubs.get(row.badge_id);
        if (list) list.push(row);
        else liveSubs.set(row.badge_id, [row]);
    }

    const rowsById = new Map((await repo.getBadges([...liveSubs.keys()])).map((b) => [b.badge_id, b]));
    const live: BadgeRow[] = [];
    for (const id of liveSubs.keys()) {
        const row = rowsById.get(id);
        if (row && !row.deleted) live.push(row);
    }
    // Oldest check first (never-checked first), so a rate-limited round does not always starve the same tail badges.
    live.sort(
        (a, b) => (a.last_checked_at?.getTime() ?? Number.NEGATIVE_INFINITY) - (b.last_checked_at?.getTime() ?? Number.NEGATIVE_INFINITY),
    );
    await repo.clearBaselines(live.map((b) => b.badge_id));

    const now = deps.now();
    const stale = live.filter((b) => now.getTime() - b.meta_refreshed_at.getTime() >= settings.meta.refreshMs);
    const icons = stale.length > 0 ? await deps.roblox.fetchIcons(stale.map((b) => b.badge_id)) : new Map<string, string>();
    const staleIds = new Set(stale.map((b) => b.badge_id));

    const spacingMs = Math.max(
        settings.round.minSpacingMs,
        Math.floor((deps.intervalMs * settings.round.spreadRatio) / Math.max(live.length, 1)),
    );
    const deadGuilds = new Set<string>();

    async function sendTo(sub: FanoutRow, payload: MessageCreateOptions): Promise<void> {
        if (deadGuilds.has(sub.guild_id) || !sub.channel_id) return;
        // Permissions and the channel can change mid-round, so check again right before sending.
        const status = deps.postStatus(sub.guild_id, sub.channel_id);
        if (status !== "ok") {
            deadGuilds.add(sub.guild_id);
            if (status === "channel_missing") await repo.clearTrackerChannelIf(sub.guild_id, sub.channel_id);
            return;
        }
        const result = await deps.send(sub.channel_id, payload);
        if (result === "forbidden") {
            deadGuilds.add(sub.guild_id);
        } else if (result === "unknown_channel") {
            deadGuilds.add(sub.guild_id);
            await repo.clearTrackerChannelIf(sub.guild_id, sub.channel_id);
        } else if (result === "failed") {
            logger.warn(`Post to guild ${sub.guild_id} failed`, { channelId: sub.channel_id });
        }
    }

    /** Re-reads the Badge's Subscriptions so changes made during the round apply; only servers that can still post stay. */
    async function freshSubs(badgeId: string): Promise<FanoutRow[]> {
        const rows = await repo.getFanoutRowsForBadge(badgeId);
        return rows.filter((r) => deps.postStatus(r.guild_id, r.channel_id) === "ok");
    }

    async function fanOut(subs: FanoutRow[], payloadFor: (sub: FanoutRow) => MessageCreateOptions): Promise<void> {
        for (let i = 0; i < subs.length; i += settings.discord.sendConcurrency) {
            await Promise.all(subs.slice(i, i + settings.discord.sendConcurrency).map((sub) => sendTo(sub, payloadFor(sub))));
        }
    }

    let checked = 0;
    for (const [index, row] of live.entries()) {
        if (index > 0) await deps.sleep(spacingMs);
        const id = row.badge_id;
        const fetched = await deps.roblox.fetchBadge(id);
        checked++;

        if (fetched.kind === "rate_limited") return { kind: "rate_limited", retryAfterMs: fetched.retryAfterMs };

        if (fetched.kind === "error") {
            logger.warn(`Badge ${id} check failed`, { message: fetched.message });
            continue;
        }

        if (fetched.kind === "not_found") {
            const streak = await repo.incrementNotFound(id);
            if (streak >= settings.deletedAfterNotFound) {
                await repo.markDeleted(id);
                const subs = await freshSubs(id);
                const payload = buildDeletedPost({
                    name: row.name,
                    lastCount: row.awarded_count === null ? null : Number(row.awarded_count),
                    iconUrl: row.icon_url,
                });
                await fanOut(subs, () => payload);
            }
            continue;
        }

        const { badge } = fetched;
        if (staleIds.has(id)) await repo.updateBadgeMeta(id, badge.name, badge.description, icons.get(id) ?? row.icon_url, now);

        const outcome = evaluateCheck(
            {
                awardedCount: row.awarded_count === null ? null : Number(row.awarded_count),
                lastCheckedAt: row.last_checked_at,
            },
            badge.awardedCount,
            now,
            deps.intervalMs,
        );
        if (outcome.kind === "decreased") {
            logger.warn(`Badge ${id} award count decreased`, { previous: row.awarded_count, current: badge.awardedCount });
        }
        await repo.recordCheck(id, badge.awardedCount, now);

        if (outcome.kind === "post") {
            const subs = await freshSubs(id);
            await fanOut(subs, (sub) =>
                buildAwardPost({
                    badgeId: id,
                    name: badge.name,
                    description: resolveDescription(sub.custom_description, badge.description),
                    iconUrl: staleIds.has(id) ? (icons.get(id) ?? row.icon_url) : row.icon_url,
                    delta: outcome.delta,
                    total: badge.awardedCount,
                    window: outcome.window,
                    pingRoleId: sub.ping_role_id && deps.roleExists(sub.guild_id, sub.ping_role_id) ? sub.ping_role_id : null,
                }),
            );
        }
    }
    return { kind: "done", checked };
}

export function defaultPollerDeps(client: BotClient, intervalMs: number): PollerDeps {
    return {
        roblox: createRobloxClient(),
        now: () => new Date(),
        sleep: (ms) => Bun.sleep(ms),
        intervalMs,
        postStatus: (guildId, channelId) => postStatus(client, guildId, channelId),
        roleExists: (guildId, roleId) => roleExists(client, guildId, roleId),
        send: async (channelId, payload) => {
            const channel = client.channels.cache.get(channelId);
            if (!channel?.isTextBased() || !("send" in channel)) return "unknown_channel";
            try {
                await channel.send(payload);
                return "sent";
            } catch (err) {
                if (err instanceof DiscordAPIError) {
                    if (err.code === 10003) return "unknown_channel";
                    if (err.code === 50001 || err.code === 50013) return "forbidden";
                }
                logger.error(`Failed to send to channel ${channelId}`, { error: err instanceof Error ? err.message : String(err) });
                return "failed";
            }
        },
        repo: {
            getAllFanoutRows,
            getBadges: badgesRepo.getBadges,
            recordCheck: badgesRepo.recordCheck,
            updateBadgeMeta: badgesRepo.updateBadgeMeta,
            clearBaselines: badgesRepo.clearBaselines,
            incrementNotFound: badgesRepo.incrementNotFound,
            markDeleted: badgesRepo.markDeleted,
            getFanoutRowsForBadge,
            clearTrackerChannelIf,
        },
    };
}
