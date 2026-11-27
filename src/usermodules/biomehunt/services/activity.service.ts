import { type Message, MessageFlags } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { transaction } from "@/database/connection";
import { Logger } from "@/utils/logging";
import { getBiomeMeta, isNormalBiome, rewardsOnDetection } from "../constants/biomes.constants";
import { inspectMessage } from "../macro-parsers";
import {
    extendSession,
    getActiveSecondsBetween,
    getActiveSecondsInWindow,
    getBiomeCountsInRange,
    getLatestSession,
    getLatestSessionForUser,
    insertEventIfNew,
    openNewSession,
    setSessionUncounted,
} from "../repository/activity.repository";
import { getGuildRoles, getOrCreateGuildConfig } from "../repository/guilds.repository";
import { getMerchantCountsInRange } from "../repository/merchant-events.repository";
import { getActivePause, type PauseRow } from "../repository/pauses.repository";
import { enqueueRoleJob } from "../repository/role-jobs.repository";
import {
    type ChannelIndexEntry,
    getMacroChannelByUserId,
    getUserById,
    lookupChannel,
    touchLastActivity,
    updateUserStatus,
} from "../repository/users.repository";
import type { ActivityGrace, ActivityStatus, ParsedEvent } from "../types";
import { buildSessionEndContainer } from "../views/session-end.view";
import { RECENT_ACTIVITY_WINDOW_HOURS } from "../views/stats-builders";
import { grantBiomeReward } from "./biome-reward.service";
import { checkAndForward } from "./forward.service";
import { trackMacroHealth } from "./macro-health.service";
import { recordMerchantFind } from "./merchant.service";
import { scheduleNetworkPostSafely } from "./network-publish.service";
import { quotaDayWindow } from "./quota.service";

const logger = new Logger("biomehunt.services.activity");

export const NO_GRACE: ActivityGrace = { until: null, biome: null };

/**
 * The moment a user's activity is measured from - their last macro message, or the end of their
 * activity grace if that's later. Timed biomes (admin events, mostly) can run longer than the idle
 * threshold with the macro silent, so while one runs the user must not go idle nor have their
 * session split; once it's over, the normal idle threshold counts from its expected end.
 */
export function effectiveLastActivity(lastActivityAt: Date | null, graceUntil: Date | null): Date | null {
    if (!lastActivityAt) return graceUntil;
    if (!graceUntil) return lastActivityAt;
    return graceUntil > lastActivityAt ? graceUntil : lastActivityAt;
}

/**
 * The grace after a macro event. Only the most recently started biome counts (Biome Randomizer /
 * Strange Controller can chain them): a Started of a biome with a `durationS` grants
 * `now + durationS`, a Started of any other biome drops the grace. An Ended of the grace's own biome
 * ends it early - not every macro sends Ended, so the next Started also does. Anything else keeps it.
 */
export function nextActivityGrace(current: ActivityGrace, event: Pick<ParsedEvent, "biome" | "eventType">, now: Date): ActivityGrace {
    if (!event.biome) return current;
    if (event.eventType === "started") {
        // A timed biome serving as the normal one has nothing to wait for.
        const durationS = isNormalBiome(event.biome) ? undefined : getBiomeMeta(event.biome)?.durationS;
        return durationS ? { until: new Date(now.getTime() + durationS * 1000), biome: event.biome } : NO_GRACE;
    }
    if (event.eventType === "ended" && current.biome === event.biome) return NO_GRACE;
    return current;
}

export async function transitionUser(userId: number, guildId: string, newStatus: ActivityStatus): Promise<void> {
    await updateUserStatus(userId, newStatus);

    const roles = await getGuildRoles(guildId);
    const roleForStatus: Record<ActivityStatus, string | null> = {
        active: roles.active,
        idle: roles.idle,
        inactive: roles.inactive,
    };

    const addRoleId = roleForStatus[newStatus];
    if (addRoleId) await enqueueRoleJob(guildId, userId, addRoleId, "add");

    for (const status of Object.keys(roleForStatus) as ActivityStatus[]) {
        if (status === newStatus) continue;
        const removeRoleId = roleForStatus[status];
        if (removeRoleId) await enqueueRoleJob(guildId, userId, removeRoleId, "remove");
    }
}

export async function processIncomingMessage(message: Message): Promise<void> {
    const entry = lookupChannel(message.channelId);
    if (!entry) return;

    if (!message.webhookId || message.webhookId !== entry.webhookId) {
        logger.warn(`Rejected message in tracked channel ${message.channelId}: webhook id mismatch`);
        return;
    }

    const inspection = inspectMessage(message);
    const { event: parsed, checkpoint } = inspection;
    // Before the early return: unreadable embeds are what the warning counts.
    await trackMacroHealth(message, entry, inspection).catch((err) => logger.error(err instanceof Error ? err : new Error(String(err))));
    const now = new Date();

    if (parsed) await recordBiomeEvent(message, entry, parsed, now);
    // A checkpoint is no find, but it proves the macro is hunting: it counts as macro time.
    else if (checkpoint) {
        const { merchant } = checkpoint;
        if (merchant) {
            const find = { userId: entry.userId, merchant, macroType: inspection.parserId, serverLink: inspection.serverLink };
            // A failed record or forward must not cost the member their macro time.
            await recordMerchantFind(message, entry.guildId, find).catch((err) =>
                logger.error(err instanceof Error ? err : new Error(String(err))),
            );
        }
        await recordActivity(entry, checkpoint, now);
    } else logger.verbose(`No biome or checkpoint parsed for message ${message.id}`);
}

/** Stores the find, rewards and forwards it, and counts it as activity. A message seen before does nothing. */
async function recordBiomeEvent(message: Message, entry: ChannelIndexEntry, parsed: ParsedEvent, now: Date): Promise<void> {
    const eventId = await transaction((client) =>
        insertEventIfNew(client, entry.userId, message.id, parsed.biome, parsed.macroType, parsed.eventType, parsed.eventTimestamp),
    );
    if (eventId === null) return;

    const user = await getUserById(entry.userId);
    if (!user) return;

    if (parsed.eventType === "started" && parsed.biome) {
        if (rewardsOnDetection(parsed.biome)) await grantBiomeReward(entry.guildId, entry.userId, eventId, parsed.biome);
    }

    logger.verbose(`checkAndForward: ${entry.guildId} ${user.discord_user_id} :: Parsed -> ${JSON.stringify(parsed)}`);
    await checkAndForward(message, entry.guildId, entry.userId, parsed, eventId);
    if (parsed.eventType === "started" && parsed.biome && message.guild) {
        await scheduleNetworkPostSafely(message.client, {
            originGuildId: entry.guildId,
            originName: message.guild.name,
            originIconUrl: message.guild.iconURL(),
            finderDiscordId: user.discord_user_id,
            eventId,
            biome: parsed.biome,
            serverLink: parsed.serverLink,
            now,
        });
    }

    await recordActivity(entry, parsed, now);
}

/** Opens or extends the member's session and marks them active. */
async function recordActivity(entry: ChannelIndexEntry, event: Pick<ParsedEvent, "biome" | "eventType">, now: Date): Promise<void> {
    const user = await getUserById(entry.userId);
    if (!user) return;

    const guildConfig = await getOrCreateGuildConfig(entry.guildId);
    // Measured from the end of a running timed biome too, so a long admin event doesn't split the session.
    const lastActivity = effectiveLastActivity(user.last_activity_at, user.activity_grace_until);
    const deltaSeconds = lastActivity ? (now.getTime() - lastActivity.getTime()) / 1000 : Number.POSITIVE_INFINITY;

    const markUncounted = shouldMarkUncounted(await getActivePause(entry.userId));
    await transaction(async (client) => {
        let session: { id: number };
        if (deltaSeconds > guildConfig.session_gap_threshold_s) {
            session = await openNewSession(client, entry.userId, now);
        } else {
            const latest = await getLatestSession(client, entry.userId);
            session = latest ? await extendSession(client, latest.id, now) : await openNewSession(client, entry.userId, now);
        }
        if (markUncounted) await setSessionUncounted(client, session.id);
    });

    const currentGrace = { until: user.activity_grace_until, biome: user.activity_grace_biome };
    await touchLastActivity(entry.userId, now, nextActivityGrace(currentGrace, event, now));

    if (user.current_status !== "active") {
        await transitionUser(entry.userId, entry.guildId, "active");
    }
}

/** A pause that does not count keeps the member's sessions out of every stat and quota while it lasts. */
export function shouldMarkUncounted(pause: PauseRow | null): boolean {
    return pause !== null && !pause.counts;
}

/** Posts a summary of a user's just-finished session (duration + biome breakdown) to their macro channel. */
export async function reportSessionEnd(client: BotClient, userId: number): Promise<void> {
    const session = await getLatestSessionForUser(userId);
    if (!session) return;

    const macroChannel = await getMacroChannelByUserId(userId);
    if (!macroChannel) return;

    const channel = await client.channels.fetch(macroChannel.channel_id).catch(() => null);
    if (!channel || channel.isDMBased() || !channel.isTextBased()) return;

    const user = await getUserById(userId);
    if (!user) return;

    const guildConfig = await getOrCreateGuildConfig(user.guild_id);
    const quotaDay = quotaDayWindow(guildConfig.quota_eval_hour_utc, new Date());

    const [biomes, merchants, windowSeconds, todaySeconds] = await Promise.all([
        getBiomeCountsInRange(userId, session.started_at, session.ended_at),
        getMerchantCountsInRange(userId, session.started_at, session.ended_at),
        getActiveSecondsInWindow(userId, RECENT_ACTIVITY_WINDOW_HOURS),
        getActiveSecondsBetween(userId, quotaDay.start, quotaDay.end),
    ]);
    const totals = { todaySeconds, windowSeconds, windowHours: RECENT_ACTIVITY_WINDOW_HOURS };
    const container = buildSessionEndContainer(session, biomes, totals, merchants);

    try {
        await channel.send({ flags: MessageFlags.IsComponentsV2, components: [container] });
    } catch (err) {
        logger.error(err instanceof Error ? err : new Error(String(err)), { userId });
    }
}
