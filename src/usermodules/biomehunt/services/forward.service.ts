import type { Client, Message } from "discord.js";
import { MessageFlags } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { Logger } from "@/utils/logging";
import { formatBiomeName, getBiomeMeta, resolveBiomeSelector } from "../constants/biomes.constants";
import { eventExists, getBiomeCountForUser, getGuildBiomeFindStats } from "../repository/activity.repository";
import { getDelayedForwardConfig, removeDelayedForwardConfig, setDelayedForwardConfig } from "../repository/delayed-forwards.repository";
import { getForwardConfig } from "../repository/forwards.repository";
import { getUserById } from "../repository/users.repository";
import { getVoteById } from "../repository/votes.repository";
import { settings } from "../settings";
import { type BiomeDelayedForwardRow, type BiomeForwardRow, BiomeHuntError, type ParsedEvent, VoteStatus } from "../types";
import { buildForwardContainer, type ForwardFindStats, forwardMentions } from "../views/forward-post.view";
import { getVoteWindowMs, newVoteId, openVote } from "./biome-vote.service";
import { clearLogDedup, describeDiscordError, type GuildLogEntry, guildLog } from "./guild-log.service";

const logger = new Logger("biomehunt.services.forward");

/**
 * Everything `forwardBiome` would otherwise call directly on the repository/vote service, injected
 * so its tests (and `checkAndForward`'s) never touch a DB - `defaultForwardServiceDeps` wires the
 * real functions.
 */
export interface ForwardServiceDeps {
    getForwardConfig: typeof getForwardConfig;
    getDelayedForwardConfig: typeof getDelayedForwardConfig;
    getBiomeCountForUser: typeof getBiomeCountForUser;
    getGuildBiomeFindStats: typeof getGuildBiomeFindStats;
    getUserById: typeof getUserById;
    newVoteId: typeof newVoteId;
    openVote: typeof openVote;
    /** The local vote's current duration (`getVoteWindowMs("local")`). */
    voteWindowMs: () => Promise<number>;
    scheduleDelayedForward: typeof scheduleDelayedForward;
    /** Posts a problem to the server's log channel. */
    log: typeof logToGuild;
}

/** `guildLog` for the plain discord.js client the forward pipeline carries (it is the bot's client at runtime). */
const logToGuild = (client: Client, guildId: string, entry: GuildLogEntry) => guildLog(client as BotClient, guildId, entry);

/** The log post for a forward that couldn't be sent. */
function forwardFailure(biome: string, finderDiscordId: string | null, channelId: string, err: unknown): GuildLogEntry {
    const from = finderDiscordId ? ` from <@${finderDiscordId}>` : "";
    return {
        kind: "warning",
        title: "⚠️ Couldn't post a forward",
        body: `**${formatBiomeName(biome)}**${from} wasn't posted in <#${channelId}>: ${describeDiscordError(err)}.`,
        dedupKey: `forward:${channelId}`,
    };
}

export function defaultForwardServiceDeps(): ForwardServiceDeps {
    return {
        getForwardConfig,
        getDelayedForwardConfig,
        getBiomeCountForUser,
        getGuildBiomeFindStats,
        getUserById,
        newVoteId,
        openVote,
        voteWindowMs: () => getVoteWindowMs("local"),
        scheduleDelayedForward,
        log: logToGuild,
    };
}

/**
 * Forwards a detected biome to its configured channel, every time it happens (no throttle -
 * this is a live "someone found X" alert, same trigger semantics as the badge system: only
 * a confirmed 'started' event fires it. Builds the jump link from the source message, then
 * delegates everything else to `forwardBiome`.
 */
export async function checkAndForward(
    message: Message,
    guildId: string,
    userId: number,
    parsed: ParsedEvent,
    eventId: number,
    deps: ForwardServiceDeps = defaultForwardServiceDeps(),
): Promise<void> {
    const jumpLink = `https://discord.com/channels/${guildId}/${message.channelId}/${message.id}`;
    await forwardBiome(message.client, guildId, userId, parsed, eventId, jumpLink, deps);
}

/**
 * The core of `checkAndForward`, factored out so `/owner simulate-biome` can drive the exact
 * same forward+vote pipeline for a synthetic event - it has no source message to derive a jump
 * link from, so it supplies its own (a link to the invoking message, or the channel). Sends the
 * live forward (if configured) right away and schedules the delayed forward (if configured) -
 * the two are independent, a biome can have either or both.
 *
 * A dry run (`eventId === null`, only `/owner simulate-biome` does that) must bother no one and
 * change nothing: neither message pings anyone and no vote is opened (no vote/ballot rows).
 */
export async function forwardBiome(
    client: Client,
    guildId: string,
    userId: number,
    parsed: ParsedEvent,
    /** `null` for a dry-run simulation - see above. */
    eventId: number | null,
    jumpLink: string,
    deps: ForwardServiceDeps = defaultForwardServiceDeps(),
): Promise<void> {
    if (parsed.eventType !== "started" || !parsed.biome) return;
    const biome = parsed.biome;

    const [forward, delayed] = await Promise.all([deps.getForwardConfig(guildId, biome), deps.getDelayedForwardConfig(guildId, biome)]);
    if (!forward && !delayed) return;

    const now = new Date();
    const dryRun = eventId === null;
    const stats = await loadFindStats(guildId, userId, biome, eventId, deps);
    const voteId = forward
        ? await sendLiveForward(client, guildId, userId, parsed, biome, eventId, jumpLink, forward, stats, now, deps)
        : null;

    if (delayed) {
        deps.scheduleDelayedForward({
            client,
            guildId,
            config: delayed,
            biome,
            serverLink: parsed.serverLink,
            jumpLink,
            stats,
            eventId,
            voteId,
            dryRun,
        });
    }
}

/**
 * The card's finder/count lines. A dry run inserted no event, so its counts are bumped by one to
 * read like the real find would; a real find is already in both counts.
 */
async function loadFindStats(
    guildId: string,
    userId: number,
    biome: string,
    eventId: number | null,
    deps: ForwardServiceDeps,
): Promise<ForwardFindStats> {
    const [finder, personal, server] = await Promise.all([
        deps.getUserById(userId),
        deps.getBiomeCountForUser(userId, biome),
        deps.getGuildBiomeFindStats(guildId, biome, eventId),
    ]);
    const bump = eventId === null ? 1 : 0;
    return {
        finderDiscordId: finder?.discord_user_id ?? null,
        findCount: personal + bump,
        serverFindCount: server.count + bump,
        lastSeenInServerAt: server.lastFoundAt,
    };
}

/**
 * Uses a Components V2 container instead of a regular embed so we get a real Separator between the
 * heading and the details. Rare-category biomes additionally open a 1-minute community vote (see
 * services/biome-vote.service.ts) - the vote id is generated here, BEFORE the message is sent, so
 * the message can show it right away. Resolves the opened vote's id, or `null` if none was opened.
 */
async function sendLiveForward(
    client: Client,
    guildId: string,
    userId: number,
    parsed: ParsedEvent,
    biome: string,
    eventId: number | null,
    jumpLink: string,
    forward: BiomeForwardRow,
    stats: ForwardFindStats,
    now: Date,
    deps: ForwardServiceDeps,
): Promise<string | null> {
    const channel = await client.channels.fetch(forward.channel_id).catch(() => null);
    if (!channel || channel.isDMBased() || !channel.isTextBased()) return null;

    const dryRun = eventId === null;
    const isRare = getBiomeMeta(biome)?.category === "rare";
    const voteId = isRare && !dryRun ? deps.newVoteId() : null;
    const closesAt = new Date(now.getTime() + (voteId ? await deps.voteWindowMs() : 0));

    const container = buildForwardContainer({
        biome,
        roleId: forward.role_id,
        serverLink: parsed.serverLink,
        jumpLink,
        ...stats,
        vote: voteId ? { voteId, status: VoteStatus.OPEN, closesAt, voteCount: 0 } : undefined,
        badges: dryRun ? { simulated: true } : undefined,
        flavorText: getBiomeMeta(biome)?.flavorText,
    });

    let sent: Message | undefined;
    try {
        sent = await channel.send({
            components: [container],
            flags: MessageFlags.IsComponentsV2,
            allowedMentions: forwardMentions(forward.role_id, dryRun),
        });
        if (!voteId) return null;
        await deps.openVote({
            voteId,
            guildId,
            eventId,
            finderUserId: userId,
            channelId: sent.channelId,
            messageId: sent.id,
            biome,
            roleId: forward.role_id,
            serverLink: parsed.serverLink,
            jumpLink,
            ...stats,
            closesAt,
        });
        clearLogDedup(guildId, `forward:${forward.channel_id}`);
        return voteId;
    } catch (err) {
        logger.error(err instanceof Error ? err : new Error(String(err)), { guildId, biome });
        // Only a failed send is a forward problem; a vote that failed to open after it is not.
        if (!sent) await deps.log(client, guildId, forwardFailure(biome, stats.finderDiscordId ?? null, forward.channel_id, err));
        return null;
    }
}

/** Injected so tests never touch the DB or wait on a real timer - `defaultDelayedForwardDeps` wires the real ones. */
export interface DelayedForwardDeps {
    eventExists: typeof eventExists;
    getVoteById: typeof getVoteById;
    schedule(fn: () => Promise<void>, ms: number): void;
    log: typeof logToGuild;
}

export function defaultDelayedForwardDeps(): DelayedForwardDeps {
    return {
        eventExists,
        getVoteById,
        schedule: (fn, ms) => {
            setTimeout(() => void fn(), ms);
        },
        log: logToGuild,
    };
}

/** Everything the delayed message needs, captured at find time - nothing is re-derived when the timer fires. */
export interface DelayedForwardJob {
    client: Client;
    guildId: string;
    config: BiomeDelayedForwardRow;
    biome: string;
    serverLink: string | null;
    jumpLink: string;
    stats: ForwardFindStats;
    /** `null` for a dry-run simulation - there's no event that could get deleted. */
    eventId: number | null;
    /** The live forward's vote, if it opened one - a fake/denied outcome cancels the delayed send. */
    voteId: string | null;
    /** A `/owner simulate-biome` dry run - sent without pinging anyone. */
    dryRun: boolean;
}

/**
 * Sends the delayed forward `config.delay_s` seconds from now. The pending send only lives in
 * memory (a restart drops it) - accepted, since delays are capped at 60s.
 */
export function scheduleDelayedForward(job: DelayedForwardJob, deps: DelayedForwardDeps = defaultDelayedForwardDeps()): void {
    deps.schedule(() => sendDelayedForward(job, deps), job.config.delay_s * 1000);
}

/** A find invalidated during the delay (its event deleted, or its vote ruled fake) never gets the delayed ping. */
async function isInvalidated(job: DelayedForwardJob, deps: DelayedForwardDeps): Promise<boolean> {
    if (job.eventId !== null && !(await deps.eventExists(job.eventId))) return true;
    if (!job.voteId) return false;
    const vote = await deps.getVoteById(job.voteId);
    return vote?.status === VoteStatus.COMMUNITY_FAKE || vote?.status === VoteStatus.ADMIN_DENIED;
}

export async function sendDelayedForward(job: DelayedForwardJob, deps: DelayedForwardDeps = defaultDelayedForwardDeps()): Promise<void> {
    try {
        if (await isInvalidated(job, deps)) {
            logger.info(`Delayed forward of ${job.biome} cancelled - find was invalidated during the delay`, { guildId: job.guildId });
            return;
        }

        const channel = await job.client.channels.fetch(job.config.channel_id).catch(() => null);
        if (!channel || channel.isDMBased() || !channel.isTextBased()) return;

        const container = buildForwardContainer({
            biome: job.biome,
            roleId: job.config.role_id,
            serverLink: job.serverLink,
            jumpLink: job.jumpLink,
            ...job.stats,
            badges: { delayed: true, simulated: job.dryRun },
            flavorText: getBiomeMeta(job.biome)?.flavorText,
        });
        await channel.send({
            components: [container],
            flags: MessageFlags.IsComponentsV2,
            allowedMentions: forwardMentions(job.config.role_id, job.dryRun),
        });
        clearLogDedup(job.guildId, `forward:${job.config.channel_id}`);
    } catch (err) {
        logger.error(err instanceof Error ? err : new Error(String(err)), { guildId: job.guildId, biome: job.biome });
        await deps.log(job.client, job.guildId, forwardFailure(job.biome, job.stats.finderDiscordId ?? null, job.config.channel_id, err));
    }
}

/** Prefix invocations don't enforce the slash option's choices, so the delay is re-checked here. */
function requireValidDelay(delayS: number | null): number {
    const choices: readonly number[] = settings.delayedForward.delayChoicesS;
    if (delayS === null) throw new BiomeHuntError("Missing required argument: delay");
    if (!choices.includes(delayS)) throw new BiomeHuntError(`Delay must be one of: ${choices.join(", ")} seconds.`);
    return delayS;
}

/**
 * Omitting `channel` (with no `role`/`delay` either) removes the
 * delayed forward instead. Setting one requires a delay.
 */
export async function setDelayedForward(
    guildId: string,
    selector: string,
    channelId: string | null,
    roleId: string | null,
    delayS: number | null,
): Promise<string> {
    if (!channelId) {
        if (roleId || delayS !== null) throw new BiomeHuntError("Missing required argument: channel");
        return removeDelayedForward(guildId, selector);
    }

    const delay = requireValidDelay(delayS);
    const biomes = resolveBiomeSelector(selector);
    if (biomes.some((biome) => getBiomeMeta(biome)?.category !== "rare")) {
        throw new BiomeHuntError("Delayed forwards are only for rare biomes.");
    }
    for (const biome of biomes) await setDelayedForwardConfig(guildId, biome, channelId, roleId, delay);

    const roleNote = roleId ? `, pinging <@&${roleId}>` : "";
    const target = `<#${channelId}> after ${delay}s${roleNote}`;
    if (biomes.length === 1) return `${formatBiomeName(biomes[0])} will now be delay-forwarded to ${target}.`;
    return `${biomes.length} biomes will now be delay-forwarded to ${target}: ${biomes.map(formatBiomeName).join(", ")}.`;
}

async function removeDelayedForward(guildId: string, selector: string): Promise<string> {
    const biomes = resolveBiomeSelector(selector);
    const removed: string[] = [];
    for (const biome of biomes) {
        if (await removeDelayedForwardConfig(guildId, biome)) removed.push(biome);
    }

    if (removed.length === 0) throw new BiomeHuntError("No matching delayed biome forward is configured.");
    if (removed.length === 1) return `Delayed forward for ${formatBiomeName(removed[0])} removed.`;
    return `Removed ${removed.length} delayed biome forward(s): ${removed.map(formatBiomeName).join(", ")}.`;
}
