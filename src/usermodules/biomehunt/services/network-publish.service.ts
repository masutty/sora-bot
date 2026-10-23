import type { Client, MessageCreateOptions } from "discord.js";
import { MessageFlags } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { requireSnowflake } from "@/define";
import { NO_PINGS } from "@/utils/format";
import { Logger } from "@/utils/logging";
import { newTraceRef } from "@/utils/trace";
import { formatBiomeName, getBiomeMeta } from "../constants/biomes.constants";
import { getDelayedForwardConfig } from "../repository/delayed-forwards.repository";
import {
    getMemberNetworkGuilds,
    getNetworkGuild,
    getNetworkPingRolesForBiome,
    isNetworkBanned,
    isNetworkExcluded,
} from "../repository/network.repository";
import {
    claimNetworkPost,
    getDuePendingPosts,
    getRecentNetworkPosts,
    getStalePublishingPosts,
    hasNetworkAlert,
    insertNetworkAlert,
    insertNetworkMirror,
    insertNetworkPost,
    markNetworkPostDiscarded,
    markNetworkPostPublished,
} from "../repository/network-posts.repository";
import { settings } from "../settings";
import { BiomeHuntError, type NetworkGuildRow, type NetworkPostRow, NetworkStatus } from "../types";
import { buildMirrorContainer, serverNameLink } from "../views/network-mirror.view";
import { getVoteWindowMs } from "./biome-vote.service";
import { clearLogDedup, describeDiscordError, guildLog } from "./guild-log.service";
import { type EligibilityReport, getNetworkBiomes, loadEligibility } from "./network-eligibility.service";
import { notifyOwners } from "./owner-dm.service";

const logger = new Logger("biomehunt.services.network-publish");

const ROBLOX_HOSTS = new Set(["roblox.com", "www.roblox.com"]);

/** Codes and place ids are plain tokens - anything else (markdown, brackets, spaces) is refused, never escaped. */
const CODE_RE = /^[\w-]{1,128}$/;
const PLACE_ID_RE = /^\d{1,20}$/;

export interface PrivateServerLink {
    /** The private server's identity - also what deduplication compares. */
    code: string;
    /** A clean link rebuilt from the validated parts only - the macro's own text never reaches another server. */
    url: string;
}

/**
 * The private server behind a macro's server link, or `null` if the link doesn't lead to one - the
 * Network only publishes finds you can actually join. Accepts the two shapes Roblox hands out
 * (https only): `roblox.com/share?code=…&type=Server` and `roblox.com/games/<placeId>/…?privateServerLinkCode=…`.
 */
export function parsePrivateServerLink(link: string | null): PrivateServerLink | null {
    if (!link) return null;
    let url: URL;
    try {
        url = new URL(link);
    } catch {
        return null;
    }
    if (url.protocol !== "https:" || !ROBLOX_HOSTS.has(url.hostname.toLowerCase())) return null;

    if (url.pathname === "/share") {
        const code = url.searchParams.get("code");
        if (!code || !CODE_RE.test(code) || url.searchParams.get("type")?.toLowerCase() !== "server") return null;
        return { code, url: `https://www.roblox.com/share?code=${code}&type=Server` };
    }

    const placeId = url.pathname.split("/")[2];
    const code = url.searchParams.get("privateServerLinkCode");
    if (url.pathname.startsWith("/games/") && placeId && PLACE_ID_RE.test(placeId) && code && CODE_RE.test(code)) {
        return { code, url: `https://www.roblox.com/games/${placeId}?privateServerLinkCode=${code}` };
    }
    return null;
}

/** Everything scheduling and publishing would otherwise call on the DB or Discord, injected so tests touch neither. */
export interface NetworkPublishDeps {
    getNetworkGuild: typeof getNetworkGuild;
    isNetworkBanned: typeof isNetworkBanned;
    isNetworkExcluded: typeof isNetworkExcluded;
    loadEligibility: (guildId: string) => Promise<EligibilityReport>;
    getDelayedForwardConfig: typeof getDelayedForwardConfig;
    getRecentNetworkPosts: typeof getRecentNetworkPosts;
    insertNetworkPost: typeof insertNetworkPost;
    hasNetworkAlert: typeof hasNetworkAlert;
    insertNetworkAlert: typeof insertNetworkAlert;
    notifyOwners: (payload: MessageCreateOptions) => Promise<void>;
    newPostId: () => string;
    getDuePendingPosts: typeof getDuePendingPosts;
    getStalePublishingPosts: typeof getStalePublishingPosts;
    claimNetworkPost: typeof claimNetworkPost;
    markNetworkPostPublished: typeof markNetworkPostPublished;
    markNetworkPostDiscarded: typeof markNetworkPostDiscarded;
    getMemberNetworkGuilds: typeof getMemberNetworkGuilds;
    getNetworkPingRolesForBiome: typeof getNetworkPingRolesForBiome;
    insertNetworkMirror: typeof insertNetworkMirror;
    /** Sends one Mirror - `null` if the channel is gone or the send failed. Must never throw. */
    sendMirror: (
        channelId: string,
        payload: MessageCreateOptions,
        target: MirrorTarget,
    ) => Promise<{ channelId: string; messageId: string } | null>;
    /** The send order - random in production, so the same server isn't always the last to get it. */
    shuffle: <T>(items: T[]) => T[];
    /** The Network vote's current duration (`getVoteWindowMs("network")`). */
    voteWindowMs: () => Promise<number>;
    now: () => Date;
}

export function defaultNetworkPublishDeps(client: Client): NetworkPublishDeps {
    return {
        getNetworkGuild,
        isNetworkBanned,
        isNetworkExcluded,
        loadEligibility: (guildId) => loadEligibility(guildId),
        getDelayedForwardConfig,
        getRecentNetworkPosts,
        insertNetworkPost,
        hasNetworkAlert,
        insertNetworkAlert,
        notifyOwners: (payload) => notifyOwners(client, payload),
        newPostId: newTraceRef,
        getDuePendingPosts,
        getStalePublishingPosts,
        claimNetworkPost,
        markNetworkPostPublished,
        markNetworkPostDiscarded,
        getMemberNetworkGuilds,
        getNetworkPingRolesForBiome,
        insertNetworkMirror,
        sendMirror: (channelId, payload, target) => sendMirror(client, channelId, payload, target),
        shuffle: shuffleInPlace,
        voteWindowMs: () => getVoteWindowMs("network"),
        now: () => new Date(),
    };
}

/** Fisher-Yates on a copy. */
function shuffleInPlace<T>(items: T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

/** Who a Mirror goes to, for the log post when it can't be sent. */
export interface MirrorTarget {
    guildId: string;
    biome: string;
}

async function logMirrorFailure(client: Client, channelId: string, target: MirrorTarget, reason: string): Promise<void> {
    await guildLog(client as BotClient, target.guildId, {
        kind: "warning",
        title: "⚠️ Couldn't post a Network find",
        body: `**${formatBiomeName(target.biome)}** from the Network wasn't posted in <#${channelId}>: ${reason}.`,
        dedupKey: `mirror:${target.guildId}`,
    });
}

async function sendMirror(client: Client, channelId: string, payload: MessageCreateOptions, target: MirrorTarget) {
    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel) {
            await logMirrorFailure(client, channelId, target, "the channel no longer exists");
            return null;
        }
        if (channel.isDMBased() || !channel.isTextBased()) {
            await logMirrorFailure(client, channelId, target, "it isn't a text channel");
            return null;
        }
        const sent = await channel.send(payload);
        clearLogDedup(target.guildId, `mirror:${target.guildId}`);
        return { channelId: sent.channelId, messageId: sent.id };
    } catch (err) {
        logger.warn(`Could not send a Network Mirror to channel ${channelId}`, { error: err instanceof Error ? err.message : String(err) });
        await logMirrorFailure(client, channelId, target, describeDiscordError(err));
        return null;
    }
}

/**
 * Why `finder`'s find in `originGuildId` can't go to the Network right now, or `null` if it can.
 * Checked when the find arrives AND again at send time (a ban, removal or exclusion in between wins).
 */
async function publishBlocker(originGuildId: string, finderDiscordId: string, deps: NetworkPublishDeps): Promise<string | null> {
    const origin = await deps.getNetworkGuild(originGuildId);
    if (!origin || origin.status !== NetworkStatus.MEMBER) return "origin is not a Network member";
    if (origin.forced && (await deps.loadEligibility(originGuildId)).gaps.length > 0) return "forced origin does not pass the checklist";
    if (await deps.isNetworkBanned("guild", originGuildId)) return "origin is Network-banned";
    if (await deps.isNetworkBanned("user", finderDiscordId)) return "finder is Network-banned";
    if (await deps.isNetworkExcluded(originGuildId, finderDiscordId)) return "finder is Network-excluded";
    return null;
}

export interface ScheduleInput {
    originGuildId: string;
    originName: string;
    originIconUrl: string | null;
    finderDiscordId: string;
    eventId: number | null;
    biome: string;
    serverLink: string | null;
    now: Date;
}

export type ScheduleResult =
    | { kind: "scheduled"; postId: string }
    | { kind: "skipped"; reason: string }
    | { kind: "duplicate" }
    | { kind: "multi_macro" };

/**
 * Per-biome mutex for the dedup's read-then-insert: one macro firing two webhooks lands both events
 * at the same moment, and without it both would read "nothing recent" and both publish. In-process
 * is enough - the bot runs as a single process.
 */
const dedupLocks = new Map<string, Promise<unknown>>();

async function withDedupLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = dedupLocks.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.catch(() => undefined);
    dedupLocks.set(key, tail);
    try {
        return await run;
    } finally {
        if (dedupLocks.get(key) === tail) dedupLocks.delete(key);
    }
}

/**
 * A rare find in a Member Server becomes a pending Network Post, published by the Worker once the
 * origin's own local post is out plus the home advantage. Same user + biome from another server
 * inside the dedup window = Multi Macro (dropped, the first post keeps the credit, the owners are
 * told) - checked first, since one macro posting to two servers carries the same private server.
 * Same private server from a different user = duplicate (dropped quietly).
 */
export async function scheduleNetworkPost(input: ScheduleInput, deps: NetworkPublishDeps): Promise<ScheduleResult> {
    if (!getNetworkBiomes().includes(input.biome)) return { kind: "skipped", reason: "not a Network biome" };
    const link = parsePrivateServerLink(input.serverLink);
    if (!link) return { kind: "skipped", reason: "no private server link" };
    const blocker = await publishBlocker(input.originGuildId, input.finderDiscordId, deps);
    if (blocker) return { kind: "skipped", reason: blocker };

    return withDedupLock(input.biome, () => dedupAndInsert(input, link, deps));
}

/**
 * When the post goes out, and the origin's invite. The Network never beats the origin's own local
 * posts: if the origin has a delayed forward for this biome, its delay is waited out first - even
 * when it also has a live one - then the home advantage on top.
 */
async function postTiming(input: ScheduleInput, deps: NetworkPublishDeps): Promise<{ publishAt: Date; inviteUrl: string | null }> {
    const [delayed, origin] = await Promise.all([
        deps.getDelayedForwardConfig(input.originGuildId, input.biome),
        deps.getNetworkGuild(input.originGuildId),
    ]);
    const localDelayS = delayed?.delay_s ?? 0;
    const homeAdvantageS = settings.network.homeAdvantageS[input.biome] ?? 0;
    return { publishAt: new Date(input.now.getTime() + (localDelayS + homeAdvantageS) * 1000), inviteUrl: origin?.invite_url ?? null };
}

async function dedupAndInsert(input: ScheduleInput, link: PrivateServerLink, deps: NetworkPublishDeps): Promise<ScheduleResult> {
    const recent = await deps.getRecentNetworkPosts(input.biome, new Date(input.now.getTime() - settings.network.dedupWindowMs));
    const first = recent.find((p) => p.finder_discord_id === input.finderDiscordId && p.origin_guild_id !== input.originGuildId);
    if (first) {
        await reportMultiMacro(input, first, deps);
        return { kind: "multi_macro" };
    }
    if (recent.some((p) => p.server_code === link.code)) return { kind: "duplicate" };

    const { publishAt, inviteUrl } = await postTiming(input, deps);
    const post = await deps.insertNetworkPost({
        id: deps.newPostId(),
        originGuildId: input.originGuildId,
        originName: input.originName,
        originIconUrl: input.originIconUrl,
        inviteUrl,
        eventId: input.eventId,
        finderDiscordId: input.finderDiscordId,
        biome: input.biome,
        serverLink: link.url,
        serverCode: link.code,
        publishAt,
    });
    return { kind: "scheduled", postId: post.id };
}

/** Records the Multi Macro alert; only the user's first one ever DMs the owners right away - the rest go to the daily digest. */
async function reportMultiMacro(input: ScheduleInput, first: NetworkPostRow, deps: NetworkPublishDeps): Promise<void> {
    const originInvite = (await deps.getNetworkGuild(input.originGuildId))?.invite_url ?? null;
    const details =
        `<@${input.finderDiscordId}> (\`${input.finderDiscordId}\`) found ${formatBiomeName(input.biome)} in ${serverNameLink(input.originName, originInvite)} (\`${input.originGuildId}\`) ` +
        `while already posting it from ${serverNameLink(first.origin_name, first.invite_url)} (\`${first.origin_guild_id}\`). Only the first went to the Network.`;
    const firstEver = !(await deps.hasNetworkAlert("multi_macro", input.finderDiscordId));
    await deps.insertNetworkAlert({
        kind: "multi_macro",
        guildId: input.originGuildId,
        discordUserId: input.finderDiscordId,
        postId: first.id,
        details,
        notified: firstEver,
    });
    if (firstEver) await deps.notifyOwners({ content: `⚠️ **Multi Macro**\n${details}`, allowedMentions: NO_PINGS });
}

/**
 * The `network-publish` Worker's tick: every due pending post is claimed (compare-and-set, so two
 * ticks never send it twice), re-checked, and sent as a Mirror to every other Member Server with a
 * Network channel, in shuffled order. A post too late to matter is discarded. The vote opens once
 * the last Mirror is out.
 */
export async function publishDuePosts(deps: NetworkPublishDeps): Promise<void> {
    await finalizeStalePublishing(deps);
    const due = await deps.getDuePendingPosts(deps.now());
    for (const post of due) {
        try {
            await publishOne(post, deps);
        } catch (err) {
            logger.error(err instanceof Error ? err : new Error(String(err)), { postId: post.id });
        }
    }
}

async function publishOne(post: NetworkPostRow, deps: NetworkPublishDeps): Promise<void> {
    if (deps.now().getTime() - post.publish_at.getTime() > settings.network.publishStaleMs) {
        await deps.markNetworkPostDiscarded(post.id);
        logger.info(`Network Post ${post.id} discarded - too late to publish`);
        return;
    }
    if (!(await deps.claimNetworkPost(post.id))) return;

    // A test relay (`network_relays`, dry or not) only needs its origin to still be a member - the
    // checklist, bans and exclusions are about real finds, and this is the owner testing on purpose.
    const isTestRelay = post.simulated || post.relay_guild_ids !== null;
    const blocker = isTestRelay
        ? await simulatedBlocker(post.origin_guild_id, deps)
        : await publishBlocker(post.origin_guild_id, post.finder_discord_id, deps);
    if (blocker) {
        await deps.markNetworkPostDiscarded(post.id);
        logger.info(`Network Post ${post.id} discarded at send time - ${blocker}`);
        return;
    }

    // Every member with a Network channel - the origin included (its Home Mirror, for parity), unless
    // it's a test relay, which goes to the listed servers only.
    const relayOnly = post.relay_guild_ids ? new Set(post.relay_guild_ids) : null;
    const destinations = (await deps.getMemberNetworkGuilds()).filter(
        (g) => g.network_channel_id && (!relayOnly || relayOnly.has(g.guild_id)),
    );
    const pingRoles = await deps.getNetworkPingRolesForBiome(post.biome);
    const order = deps.shuffle(destinations);
    // Bounded concurrency: fast enough for the p95 target, without one post flooding the rate limiter.
    for (let i = 0; i < order.length; i += settings.network.publishConcurrency) {
        await Promise.all(
            order.slice(i, i + settings.network.publishConcurrency).map((guild) => sendOneMirror(post, guild, pingRoles, deps)),
        );
    }

    const publishedAt = deps.now();
    await deps.markNetworkPostPublished(post.id, publishedAt, new Date(publishedAt.getTime() + (await deps.voteWindowMs())));
}

async function sendOneMirror(
    post: NetworkPostRow,
    guild: NetworkGuildRow,
    pingRoles: Map<string, string>,
    deps: NetworkPublishDeps,
): Promise<void> {
    // A test relay never pings and never votes - it's shown as a test. The origin's own (Home) Mirror
    // never pings either: its local post already did.
    const home = guild.guild_id === post.origin_guild_id;
    const roleId = post.simulated || home ? null : (pingRoles.get(guild.guild_id) ?? null);
    const flavorText = getBiomeMeta(post.biome)?.flavorText;
    const sent = await deps.sendMirror(
        guild.network_channel_id as string,
        {
            components: [
                post.simulated
                    ? buildMirrorContainer({ post, roleId: null, simulated: true, home, flavorText })
                    : buildMirrorContainer({ post, roleId, vote: { status: "open" }, home, flavorText }),
            ],
            flags: MessageFlags.IsComponentsV2,
            allowedMentions: { parse: [], roles: roleId ? [roleId] : [] },
        },
        { guildId: guild.guild_id, biome: post.biome },
    );
    if (sent) {
        await deps.insertNetworkMirror({
            post_id: post.id,
            guild_id: guild.guild_id,
            channel_id: sent.channelId,
            message_id: sent.messageId,
            role_id: roleId,
        });
    }
}

/**
 * A post still `publishing` long after it was due means the bot died mid fan-out. It's marked
 * published so its vote opens and closes normally - the Mirrors that were recorded get the close
 * edit; any sent but unrecorded one is lost (it then answers "no longer available").
 */
async function finalizeStalePublishing(deps: NetworkPublishDeps): Promise<void> {
    const now = deps.now();
    for (const post of await deps.getStalePublishingPosts(new Date(now.getTime() - settings.network.publishStaleMs))) {
        await deps.markNetworkPostPublished(post.id, now, new Date(now.getTime() + (await deps.voteWindowMs())));
        logger.warn(`Network Post ${post.id} was stuck publishing - finalized`);
    }
}

async function simulatedBlocker(originGuildId: string, deps: NetworkPublishDeps): Promise<string | null> {
    const origin = await deps.getNetworkGuild(originGuildId);
    return origin?.status === NetworkStatus.MEMBER ? null : "this server is not a Network member";
}

/**
 * `network_relays`'s raw text → unique guild ids (comma or space separated). Throws a user-facing
 * error on anything that isn't a Discord id, or on an empty list.
 */
export function parseRelayGuildIds(raw: string): string[] {
    const ids = raw
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((id) => requireSnowflake(id));
    if (ids.length === 0) throw new BiomeHuntError("Give at least one guild id in `network_relays`.");
    return [...new Set(ids)];
}

export type SimulatedScheduleResult =
    | { kind: "scheduled"; postId: string; targets: string[]; ignored: string[] }
    | { kind: "skipped"; reason: string };

/**
 * `/owner simulate-biome network_relays:<guild ids>` - relays a simulated rare find to ONLY those
 * Member Servers, through the real pipeline (local post + home advantage, Worker, fan-out), so the
 * owner can test it end to end between test servers without touching anyone else. Ids that can't
 * receive Network posts (not a member, no Network channel, the origin itself) are ignored and
 * reported. It skips deduplication (repeated tests aren't swallowed as Multi Macro); its private
 * server is `SIM-<ref>`.
 *
 * `dryRun` (default true, like `simulate-biome`'s own) marks it as a test on every Mirror - no
 * ping, no vote. With `dryRun: false` it goes out as a real Network Post (each server's ping, the
 * Network vote and its close, a Fake verdict's alerts), just to the listed servers.
 */
export async function scheduleSimulatedNetworkPost(
    input: ScheduleInput,
    relayGuildIds: string[],
    deps: NetworkPublishDeps,
    opts: { dryRun?: boolean } = {},
): Promise<SimulatedScheduleResult> {
    if (!getNetworkBiomes().includes(input.biome))
        return { kind: "skipped", reason: `${formatBiomeName(input.biome)} is not a Network biome` };
    const blocker = await simulatedBlocker(input.originGuildId, deps);
    if (blocker) return { kind: "skipped", reason: blocker };

    const receivers = new Set(
        (await deps.getMemberNetworkGuilds())
            .filter((g) => g.guild_id !== input.originGuildId && g.network_channel_id)
            .map((g) => g.guild_id),
    );
    const targets = relayGuildIds.filter((id) => receivers.has(id));
    const ignored = relayGuildIds.filter((id) => !receivers.has(id));
    if (targets.length === 0)
        return {
            kind: "skipped",
            reason: "none of those servers can receive Network posts (member with a Network channel, not this server)",
        };

    const id = deps.newPostId();
    const code = `SIM-${id}`;
    const { publishAt, inviteUrl } = await postTiming(input, deps);
    await deps.insertNetworkPost({
        id,
        originGuildId: input.originGuildId,
        originName: input.originName,
        originIconUrl: input.originIconUrl,
        inviteUrl,
        eventId: input.eventId,
        finderDiscordId: input.finderDiscordId,
        biome: input.biome,
        serverLink: `https://www.roblox.com/share?code=${code}&type=Server`,
        serverCode: code,
        publishAt,
        simulated: opts.dryRun ?? true,
        relayGuildIds: targets,
    });
    return { kind: "scheduled", postId: id, targets, ignored };
}

/** Ingest's entry point - a Network failure must never break the local pipeline, so it only logs. */
export async function scheduleNetworkPostSafely(client: Client, input: ScheduleInput): Promise<void> {
    try {
        const result = await scheduleNetworkPost(input, defaultNetworkPublishDeps(client));
        if (result.kind !== "scheduled" && result.kind !== "skipped") {
            logger.info(`Network: ${input.biome} from ${input.originGuildId} by ${input.finderDiscordId} not scheduled (${result.kind})`);
        }
    } catch (err) {
        logger.error(err instanceof Error ? err : new Error(String(err)), { guildId: input.originGuildId, biome: input.biome });
    }
}
