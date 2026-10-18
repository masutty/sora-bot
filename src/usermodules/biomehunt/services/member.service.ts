import type { Guild, GuildMember, TextChannel } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { transaction } from "@/database/connection";
import { getBadgeMeta } from "../constants/badges.constants";
import { formatBiomeName, getBiomeMeta } from "../constants/biomes.constants";
import {
    clearBiomeEvents,
    decrementBiomeEvents,
    deleteAllSessionsForUser,
    deleteSessionsByIds,
    getBiomeCountForUser,
    insertManualBiomeEvents,
} from "../repository/activity.repository";
import { getGuildBadgeRoles } from "../repository/badges.repository";
import { enqueueRoleJob } from "../repository/role-jobs.repository";
import {
    deleteMacroChannelOnly,
    deleteUserCascade,
    getUserByDiscordId,
    getUserById,
    pauseUser,
    unpauseUser,
    wipeUserProgress,
} from "../repository/users.repository";
import { type Badge, BiomeHuntError } from "../types";
import { revertBiomeRewards, revokeOrphanedBadges } from "./biome-reward.service";
import { adoptMacroChannel, provisionMacroChannel } from "./macro-channel.service";

/** Upper bound for `incrementMemberBiome` - guards against a typo'd amount flooding the events table. */
export const MAX_MANUAL_FINDS = 1000;

function formatRewardRevertSuffix(reverted: { seedsReverted: number; xpReverted: number }, revokedBadges: Badge[]): string {
    const parts: string[] = [];
    if (reverted.seedsReverted > 0) parts.push(`-${reverted.seedsReverted} 🌱`);
    if (reverted.xpReverted > 0) parts.push(`-${reverted.xpReverted} XP`);
    if (revokedBadges.length > 0) parts.push(`${revokedBadges.map((b) => getBadgeMeta(b).display).join(", ")} badge revoked`);
    return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

async function deleteDiscordChannel(client: BotClient, channelId: string): Promise<void> {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (channel) await channel.delete().catch(() => {});
}

/**
 * Clears any macro channel already registered for this member (channel+webhook only,
 * history/badges/quota untouched) - a no-op if they don't have one. Used so `force-setup` always
 * starts from a clean slate. `keepChannelId` (the channel about to be adopted, if any) is spared
 * from Discord deletion - re-adopting the SAME channel a member already had (e.g. just to refresh
 * the webhook) shouldn't destroy it out from under itself.
 */
async function resetChannelIfAny(client: BotClient, guildId: string, discordUserId: string, keepChannelId?: string): Promise<void> {
    const user = await getUserByDiscordId(guildId, discordUserId);
    if (!user) return;
    const deleted = await deleteMacroChannelOnly(user.id);
    if (deleted && deleted.channelId !== keepChannelId) await deleteDiscordChannel(client, deleted.channelId);
}

export interface AdoptParams {
    channel: TextChannel;
    webhookUrl: string;
}

/**
 * Always starts clean: if the member already has a macro channel/webhook registered, it's reset
 * first (channel + webhook only - history/badges/quota status are untouched). Then either:
 * - `adopt` given: registers that existing channel+webhook instead of creating new ones. Response
 *   deliberately never mentions/pings the adopted member - only the calling admin sees it, and
 *   there's nothing here that needs their attention.
 * - `adopt` omitted: creates a brand new channel+webhook, same as the member running `/bh setup`
 *   themselves (existing behavior, including the optional DM).
 */
export async function forceSetupMember(
    client: BotClient,
    guild: Guild,
    member: GuildMember,
    dmUser: boolean,
    adopt: AdoptParams | null,
): Promise<string> {
    await resetChannelIfAny(client, guild.id, member.id, adopt?.channel.id);

    if (adopt) {
        const result = await adoptMacroChannel(guild, member, adopt.channel, adopt.webhookUrl);
        return `Channel <#${result.channelId}> adopted for \`${member.user.username}\` - renamed and registered. They can start using it right away, no \`/bh setup\` needed.`;
    }

    const result = await provisionMacroChannel(guild, member, { dmUser });
    if (dmUser) return `Setup complete for <@${member.id}>. Their webhook URL was sent to their DMs. Channel: <#${result.channelId}>`;
    return `Setup complete for <@${member.id}>. Channel: <#${result.channelId}>\nWebhook URL (share this with them yourself, it will not be sent to them):\n${result.webhookUrl}`;
}

/** Full wipe: channel, webhook, sessions, badges, quota status - everything. The user can /bh setup again as if brand new. */
export async function deleteMemberEverything(client: BotClient, guildId: string, discordUserId: string): Promise<string> {
    const user = await getUserByDiscordId(guildId, discordUserId);
    if (!user) throw new BiomeHuntError("That user has no data to delete.");

    const deleted = await deleteUserCascade(user.id);
    if (deleted) await deleteDiscordChannel(client, deleted.channelId);
    return `<@${discordUserId}>'s data has been fully wiped. They can run \`/bh setup\` again.`;
}

/** @deprecated Goes away with the `member-soft-delete` command (Task 15). Removes the macro channel and all sessions, keeps badges and quota status. */
export async function softDeleteMember(client: BotClient, guildId: string, discordUserId: string): Promise<string> {
    const user = await getUserByDiscordId(guildId, discordUserId);
    if (!user) throw new BiomeHuntError("That user has no data.");

    const deleted = await deleteMacroChannelOnly(user.id);
    const sessionsRemoved = await deleteAllSessionsForUser(user.id);
    if (deleted) await deleteDiscordChannel(client, deleted.channelId);

    return `<@${discordUserId}>: macro channel removed and ${sessionsRemoved} session(s) cleared. Badges and quota status kept. They can run \`/bh setup\` again.`;
}

/** Removes only the macro channel/webhook - all history, badges, and quota status stay untouched. */
export async function unlinkMember(client: BotClient, guildId: string, discordUserId: string): Promise<void> {
    const user = await getUserByDiscordId(guildId, discordUserId);
    if (!user) throw new BiomeHuntError("That user has no data.");

    const deleted = await deleteMacroChannelOnly(user.id);
    if (!deleted) throw new BiomeHuntError("That user doesn't have a macro channel.");
    await deleteDiscordChannel(client, deleted.channelId);
}

export interface ResetTotals {
    sessions: number;
    finds: number;
    badges: number;
    seeds: number;
    xp: number;
}

/**
 * Erases a member's progress: biome finds (and their rewards), sessions, badges, quota status,
 * Seeds and XP. The macro channel and Flower stay, and it works for members with no channel.
 * Held badge and quota roles are queued for removal in the same transaction.
 */
export async function resetMemberProgress(
    guildId: string,
    discordUserId: string,
    run: typeof transaction = transaction,
): Promise<ResetTotals> {
    const user = await getUserByDiscordId(guildId, discordUserId);
    if (!user) throw new BiomeHuntError("That user has no data.");

    const badgeRoles = new Map((await getGuildBadgeRoles(guildId)).map((r) => [r.badge, r.role_id]));
    return run(async (db) => {
        const wiped = await wipeUserProgress(db, user.id);
        const roleIds = new Set<string>(wiped.quotaRoleIds);
        for (const badge of wiped.badges) {
            const roleId = badgeRoles.get(badge);
            if (roleId) roleIds.add(roleId);
        }
        for (const roleId of roleIds) await enqueueRoleJob(guildId, user.id, roleId, "remove", undefined, db);
        return { sessions: wiped.sessions, finds: wiped.finds, badges: wiped.badges.length, seeds: wiped.seeds, xp: wiped.xp };
    });
}

/** Deletes the given sessions of one member. Ids that belong to someone else are ignored. */
export async function deleteSessions(userId: number, ids: number[]): Promise<number> {
    return deleteSessionsByIds(userId, ids);
}

/** Sets a member's recorded finds of a biome to `count`, adding or removing the difference. */
export async function setBiomeCount(userId: number, biome: string, count: number): Promise<void> {
    if (!Number.isInteger(count) || count < 0) throw new BiomeHuntError("Count must be a whole number, zero or more.");
    const user = await getUserById(userId);
    if (!user) throw new BiomeHuntError("That user has no profile yet.");
    const current = await getBiomeCountForUser(userId, biome);
    if (count > current) await incrementMemberBiome(user.guild_id, user.discord_user_id, biome, count - current);
    else if (count < current) await decrementMemberBiome(user.guild_id, user.discord_user_id, biome, current - count);
}

export async function pauseMember(guildId: string, discordUserId: string): Promise<string> {
    const paused = await pauseUser(guildId, discordUserId);
    if (!paused) throw new BiomeHuntError("That user has no data.");
    return `<@${discordUserId}> is now exempt from inactivity auto-delete.`;
}

export async function unpauseMember(guildId: string, discordUserId: string): Promise<string> {
    const unpaused = await unpauseUser(guildId, discordUserId);
    if (!unpaused) throw new BiomeHuntError("That user has no data.");
    return `<@${discordUserId}> is no longer exempt from inactivity auto-delete.`;
}

export async function decrementMemberBiome(guildId: string, discordUserId: string, biome: string, amount: number): Promise<string> {
    if (amount <= 0) throw new BiomeHuntError("Amount must be greater than zero.");
    const user = await getUserByDiscordId(guildId, discordUserId);
    if (!user) throw new BiomeHuntError("That user has no profile yet.");

    const removedIds = await decrementBiomeEvents(user.id, biome, amount);
    if (removedIds.length === 0) throw new BiomeHuntError(`<@${discordUserId}> has no recorded finds for ${formatBiomeName(biome)}.`);

    const { badgeCandidates, ...reverted } = await revertBiomeRewards(user.id, removedIds);
    const revokedBadges = await revokeOrphanedBadges(guildId, user.id, badgeCandidates);

    return `Removed ${removedIds.length} recorded find(s) of ${formatBiomeName(biome)} for <@${discordUserId}>.${formatRewardRevertSuffix(reverted, revokedBadges)}`;
}

/** Records `amount` finds of a biome on a user's profile. A plain record only - no Seeds/XP/badge is granted. */
export async function incrementMemberBiome(guildId: string, discordUserId: string, biome: string, amount: number): Promise<string> {
    if (amount <= 0) throw new BiomeHuntError("Amount must be greater than zero.");
    if (amount > MAX_MANUAL_FINDS) throw new BiomeHuntError(`Amount can't be more than ${MAX_MANUAL_FINDS}.`);
    if (!getBiomeMeta(biome)) throw new BiomeHuntError(`Unknown biome: ${biome}`);
    const user = await getUserByDiscordId(guildId, discordUserId);
    if (!user) throw new BiomeHuntError("That user has no profile yet.");

    const addedIds = await insertManualBiomeEvents(user.id, biome, amount);
    return `Added ${addedIds.length} recorded find(s) of ${formatBiomeName(biome)} for <@${discordUserId}>.`;
}

export async function clearMemberBiomes(guildId: string, discordUserId: string, biome: string): Promise<string> {
    const user = await getUserByDiscordId(guildId, discordUserId);
    if (!user) throw new BiomeHuntError("That user has no profile yet.");

    const removedIds = await clearBiomeEvents(user.id, biome);
    if (removedIds.length === 0) throw new BiomeHuntError(`<@${discordUserId}> has no recorded events for ${formatBiomeName(biome)}.`);

    const { badgeCandidates, ...reverted } = await revertBiomeRewards(user.id, removedIds);
    const revokedBadges = await revokeOrphanedBadges(guildId, user.id, badgeCandidates);

    return `Cleared all ${formatBiomeName(biome)} records for <@${discordUserId}> (${removedIds.length} event(s) removed).${formatRewardRevertSuffix(reverted, revokedBadges)}`;
}
