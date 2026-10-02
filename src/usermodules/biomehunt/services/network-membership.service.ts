import type { Client, MessageCreateOptions } from "discord.js";
import { MessageFlags } from "discord.js";
import { NO_PINGS } from "@/utils/format";
import { Logger } from "@/utils/logging";
import { getOrCreateGuildConfig } from "../repository/guilds.repository";
import {
    addNetworkBan,
    addNetworkExclusion,
    ensureNetworkGuild,
    getNetworkGuild,
    isNetworkBanned,
    removeNetworkBan,
    removeNetworkExclusion,
    transitionNetworkStatus,
    updateNetworkConfig,
} from "../repository/network.repository";
import { BiomeHuntError, type NetworkBanKind, type NetworkGuildRow, NetworkStatus } from "../types";
import { buildJoinRequestContainer } from "../views/network.view";
import { defaultAnnounceDeps, sendWelcomeAnnouncement } from "./network-announce.service";
import { type EligibilityGap, type EligibilityReport, isConfigGap, loadEligibility } from "./network-eligibility.service";
import { notifyOwners } from "./owner-dm.service";

const logger = new Logger("biomehunt.services.network-membership");

/** Everything this service would otherwise call on the DB or Discord, injected so its tests touch neither. */
export interface MembershipDeps {
    getOrCreateGuildConfig: (guildId: string) => Promise<unknown>;
    ensureNetworkGuild: typeof ensureNetworkGuild;
    getNetworkGuild: typeof getNetworkGuild;
    transitionNetworkStatus: typeof transitionNetworkStatus;
    updateNetworkConfig: typeof updateNetworkConfig;
    isNetworkBanned: typeof isNetworkBanned;
    addNetworkBan: typeof addNetworkBan;
    removeNetworkBan: typeof removeNetworkBan;
    addNetworkExclusion: typeof addNetworkExclusion;
    removeNetworkExclusion: typeof removeNetworkExclusion;
    loadEligibility: (guildId: string) => Promise<EligibilityReport>;
    /** The guild's name - its id when the bot can't see it. */
    guildName: (guildId: string) => string;
    hasGuild: (guildId: string) => boolean;
    notifyOwners: (payload: MessageCreateOptions) => Promise<void>;
    /** Posts to the guild's staff channel. Must never throw. */
    notifyStaff: (row: NetworkGuildRow, content: string) => Promise<void>;
    /** Tells every Member Server that this one just joined. Must never throw. */
    welcomeNewMember: (row: NetworkGuildRow) => Promise<void>;
}

export function defaultMembershipDeps(client: Client): MembershipDeps {
    return {
        getOrCreateGuildConfig,
        ensureNetworkGuild,
        getNetworkGuild,
        transitionNetworkStatus,
        updateNetworkConfig,
        isNetworkBanned,
        addNetworkBan,
        removeNetworkBan,
        addNetworkExclusion,
        removeNetworkExclusion,
        loadEligibility: (guildId) => loadEligibility(guildId),
        guildName: (guildId) => client.guilds.cache.get(guildId)?.name ?? guildId,
        hasGuild: (guildId) => client.guilds.cache.has(guildId),
        notifyOwners: (payload) => notifyOwners(client, payload),
        notifyStaff: (row, content) => notifyStaff(client, row, content),
        welcomeNewMember: async (row) => {
            try {
                const name = client.guilds.cache.get(row.guild_id)?.name ?? row.guild_id;
                await sendWelcomeAnnouncement(name, row.invite_url, defaultAnnounceDeps(client));
            } catch (err) {
                logger.warn(`Could not announce that guild ${row.guild_id} joined the Network`, {
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        },
    };
}

/**
 * Best effort: a deleted staff channel or a missing permission is logged, never thrown - the
 * status change it reports has already been committed. Pings only the staff role.
 */
export async function notifyStaff(client: Client, row: NetworkGuildRow, content: string): Promise<void> {
    if (!row.staff_channel_id) return;
    try {
        const channel = await client.channels.fetch(row.staff_channel_id);
        if (!channel || channel.isDMBased() || !channel.isTextBased()) return;
        const ping = row.staff_role_id ? `<@&${row.staff_role_id}> ` : "";
        await channel.send({
            content: `${ping}${content}`,
            allowedMentions: { parse: [], roles: row.staff_role_id ? [row.staff_role_id] : [] },
        });
    } catch (err) {
        logger.warn(`Could not notify the Network staff of guild ${row.guild_id}`, {
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

async function requireNotBanned(guildId: string, deps: MembershipDeps): Promise<void> {
    if (await deps.isNetworkBanned("guild", guildId)) throw new BiomeHuntError("This server is banned from the Network.");
}

/** The guild's Network row, created (with its `bh_guilds` row) if missing - run before any config write. */
export async function ensureNetworkRow(guildId: string, deps: MembershipDeps): Promise<NetworkGuildRow> {
    await deps.getOrCreateGuildConfig(guildId);
    return deps.ensureNetworkGuild(guildId);
}

/**
 * `/bh-network join`, before the config flow: refuses a banned guild or one already in (or
 * waiting), then returns the gaps the config flow can't fix (forwards, activity). Empty = open the flow.
 */
export async function precheckJoin(guildId: string, deps: MembershipDeps): Promise<EligibilityGap[]> {
    await requireNotBanned(guildId, deps);
    const row = await ensureNetworkRow(guildId, deps);
    if (row.status === NetworkStatus.MEMBER) {
        throw new BiomeHuntError("This server is already in the Network. Use `/bh-network config` to change its settings.");
    }
    if (row.status === NetworkStatus.PENDING) throw new BiomeHuntError("This server's join request is already waiting for approval.");
    const report = await deps.loadEligibility(guildId);
    return report.gaps.filter((g) => !isConfigGap(g));
}

export type SubmitJoinResult = { kind: "submitted" } | { kind: "ineligible"; gaps: EligibilityGap[] } | { kind: "not_available" };

/** After the config flow: re-checks everything, moves `none` → `pending` and DMs the owners the request. */
export async function submitJoinRequest(guildId: string, deps: MembershipDeps): Promise<SubmitJoinResult> {
    await requireNotBanned(guildId, deps);
    const report = await deps.loadEligibility(guildId);
    if (report.gaps.length > 0) return { kind: "ineligible", gaps: report.gaps };

    const row = await deps.transitionNetworkStatus(guildId, [NetworkStatus.NONE], NetworkStatus.PENDING);
    if (!row) return { kind: "not_available" };

    await deps.notifyOwners({
        components: [
            buildJoinRequestContainer({ guildId, guildName: deps.guildName(guildId), inviteUrl: row.invite_url, card: report.card }),
        ],
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: NO_PINGS,
    });
    return { kind: "submitted" };
}

/** `banned`: an Approve on a guild banned while its request was pending - rejected instead. */
export type DecideResult = "ok" | "not_pending" | "banned";

/**
 * An owner's Approve/Reject on a pending request (DM button or `/bh-owner network approve|reject`).
 * Compare-and-set on `pending`: a second click, a second owner, or a request withdrawn by a leave in
 * the meantime is `not_pending`, and nothing is applied or announced twice. The ban is re-checked
 * here: a guild banned after it submitted (the ban found it still `none`, so nothing was removed)
 * must never be let in by a later Approve.
 */
export async function decideJoinRequest(guildId: string, ownerId: string, approve: boolean, deps: MembershipDeps): Promise<DecideResult> {
    const banned = approve && (await deps.isNetworkBanned("guild", guildId));
    const admit = approve && !banned;
    const to = admit ? NetworkStatus.MEMBER : NetworkStatus.NONE;
    const row = await deps.transitionNetworkStatus(guildId, [NetworkStatus.PENDING], to, { decidedBy: ownerId });
    if (!row) return "not_pending";
    await deps.notifyStaff(
        row,
        admit ? "Your server was approved and is now part of the Network." : "Your request to join the Network was rejected.",
    );
    if (admit) await deps.welcomeNewMember(row);
    return banned ? "banned" : "ok";
}

/** `/bh-network leave` - immediate. `false` if it wasn't in (or waiting). */
export async function leaveNetwork(guildId: string, deps: MembershipDeps): Promise<boolean> {
    const row = await deps.transitionNetworkStatus(guildId, [NetworkStatus.PENDING, NetworkStatus.MEMBER], NetworkStatus.NONE, {
        forced: false,
    });
    return row !== null;
}

/** Owner removal: pending or member back to `none`, forced flag cleared, staff told. */
export async function removeFromNetwork(guildId: string, ownerId: string, deps: MembershipDeps): Promise<boolean> {
    const row = await deps.transitionNetworkStatus(guildId, [NetworkStatus.PENDING, NetworkStatus.MEMBER], NetworkStatus.NONE, {
        forced: false,
        decidedBy: ownerId,
    });
    if (!row) return false;
    await deps.notifyStaff(row, "Your server was removed from the Network by the bot owner.");
    return true;
}

/** Forced entry: skips the checklist, sets the Network channel, and makes the guild a forced member. */
export async function forceIntoNetwork(guildId: string, channelId: string, ownerId: string, deps: MembershipDeps): Promise<void> {
    if (!deps.hasGuild(guildId)) throw new BiomeHuntError(`I'm not in guild \`${guildId}\`.`);
    await requireNotBanned(guildId, deps);
    await ensureNetworkRow(guildId, deps);
    await deps.updateNetworkConfig(guildId, { networkChannelId: channelId });
    await deps.transitionNetworkStatus(guildId, [NetworkStatus.NONE, NetworkStatus.PENDING, NetworkStatus.MEMBER], NetworkStatus.MEMBER, {
        forced: true,
        decidedBy: ownerId,
    });
}

/** Network Ban of a guild or user. A banned guild also loses its membership. `false` if already banned. */
export async function banFromNetwork(
    kind: NetworkBanKind,
    targetId: string,
    ownerId: string,
    reason: string | null,
    deps: MembershipDeps,
): Promise<boolean> {
    const added = await deps.addNetworkBan(kind, targetId, ownerId, reason);
    if (kind === "guild") await removeFromNetwork(targetId, ownerId, deps);
    return added;
}

export async function unbanFromNetwork(kind: NetworkBanKind, targetId: string, deps: MembershipDeps): Promise<boolean> {
    return deps.removeNetworkBan(kind, targetId);
}

/** Network Exclusion: the member's finds stop being published (Phase 2 reads it); they stay local. `false` if already excluded. */
export async function excludeMember(guildId: string, discordUserId: string, adminId: string, deps: MembershipDeps): Promise<boolean> {
    await deps.getOrCreateGuildConfig(guildId);
    return deps.addNetworkExclusion(guildId, discordUserId, adminId);
}

export async function includeMember(guildId: string, discordUserId: string, deps: MembershipDeps): Promise<boolean> {
    return deps.removeNetworkExclusion(guildId, discordUserId);
}

const SNOWFLAKE_RE = /^\d{17,20}$/;

/** Owner commands take raw ids as text - refuse anything that can't be a Discord guild/user/channel id. */
export function requireSnowflake(raw: string): string {
    const id = raw.trim();
    if (!SNOWFLAKE_RE.test(id)) throw new BiomeHuntError(`\`${raw}\` is not a Discord id.`);
    return id;
}
