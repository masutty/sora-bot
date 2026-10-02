import type { Guild, GuildMember, TextChannel } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { BADGE_META } from "../constants/badges.constants";
import { formatBiomeName } from "../constants/biomes.constants";
import { clearBiomeEvents, decrementBiomeEvents, deleteAllSessionsForUser } from "../repository/activity.repository";
import { deleteMacroChannelOnly, deleteUserCascade, getUserByDiscordId, pauseUser, unpauseUser } from "../repository/users.repository";
import { type Badge, BiomeHuntError } from "../types";
import { revertBiomeRewards, revokeOrphanedBadges } from "./biome-reward.service";
import { adoptMacroChannel, provisionMacroChannel } from "./macro-channel.service";

function formatRewardRevertSuffix(reverted: { seedsReverted: number; xpReverted: number }, revokedBadges: Badge[]): string {
    const parts: string[] = [];
    if (reverted.seedsReverted > 0) parts.push(`-${reverted.seedsReverted} 🌱`);
    if (reverted.xpReverted > 0) parts.push(`-${reverted.xpReverted} XP`);
    if (revokedBadges.length > 0) parts.push(`${revokedBadges.map((b) => BADGE_META[b].display).join(", ")} badge revoked`);
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
export async function hardDeleteMember(client: BotClient, guildId: string, discordUserId: string): Promise<string> {
    const user = await getUserByDiscordId(guildId, discordUserId);
    if (!user) throw new BiomeHuntError("That user has no data to delete.");

    const deleted = await deleteUserCascade(user.id);
    if (deleted) await deleteDiscordChannel(client, deleted.channelId);
    return `<@${discordUserId}>'s data has been fully wiped. They can run \`/bh setup\` again.`;
}

/** Removes the macro channel/webhook and all session history, but keeps badges and quota status. */
export async function softDeleteMember(client: BotClient, guildId: string, discordUserId: string): Promise<string> {
    const user = await getUserByDiscordId(guildId, discordUserId);
    if (!user) throw new BiomeHuntError("That user has no data.");

    const deleted = await deleteMacroChannelOnly(user.id);
    const sessionsRemoved = await deleteAllSessionsForUser(user.id);
    if (deleted) await deleteDiscordChannel(client, deleted.channelId);

    return `<@${discordUserId}>: macro channel removed and ${sessionsRemoved} session(s) cleared. Badges and quota status kept. They can run \`/bh setup\` again.`;
}

/** Removes only the macro channel/webhook - all history, badges, and quota status stay untouched. */
export async function resetMemberChannel(client: BotClient, guildId: string, discordUserId: string): Promise<string> {
    const user = await getUserByDiscordId(guildId, discordUserId);
    if (!user) throw new BiomeHuntError("That user has no data.");

    const deleted = await deleteMacroChannelOnly(user.id);
    if (!deleted) throw new BiomeHuntError("That user doesn't have a macro channel.");
    await deleteDiscordChannel(client, deleted.channelId);

    return `<@${discordUserId}>'s macro channel removed. All other data kept. They can run \`/bh setup\` again.`;
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

export async function clearMemberBiomes(guildId: string, discordUserId: string, biome: string): Promise<string> {
    const user = await getUserByDiscordId(guildId, discordUserId);
    if (!user) throw new BiomeHuntError("That user has no profile yet.");

    const removedIds = await clearBiomeEvents(user.id, biome);
    if (removedIds.length === 0) throw new BiomeHuntError(`<@${discordUserId}> has no recorded events for ${formatBiomeName(biome)}.`);

    const { badgeCandidates, ...reverted } = await revertBiomeRewards(user.id, removedIds);
    const revokedBadges = await revokeOrphanedBadges(guildId, user.id, badgeCandidates);

    return `Cleared all ${formatBiomeName(biome)} records for <@${discordUserId}> (${removedIds.length} event(s) removed).${formatRewardRevertSuffix(reverted, revokedBadges)}`;
}
