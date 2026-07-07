import type { Guild, GuildMember } from "discord.js";
import type { BotClient } from "@/core/BotClient";
import { runUserSetup } from "../guildSetup";
import { clearBiomeEvents, decrementBiomeEvents, deleteAllSessionsForUser } from "../repository/activity";
import { deleteMacroChannelOnly, deleteUserCascade, getUserByDiscordId, pauseUser, unpauseUser } from "../repository/users";
import { BiomeHuntError, formatBiomeName } from "../types";

async function deleteDiscordChannel(client: BotClient, channelId: string): Promise<void> {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (channel) await channel.delete().catch(() => {});
}

export async function memberForceSetupAction(guild: Guild, member: GuildMember, dmUser: boolean): Promise<string> {
    const result = await runUserSetup(guild, member, { dmUser });
    if (dmUser) return `Setup complete for <@${member.id}>. Their webhook URL was sent to their DMs. Channel: <#${result.channelId}>`;
    return `Setup complete for <@${member.id}>. Channel: <#${result.channelId}>\nWebhook URL (share this with them yourself, it will not be sent to them):\n${result.webhookUrl}`;
}

/** Full wipe: channel, webhook, sessions, badges, quota status - everything. The user can /bh setup again as if brand new. */
export async function memberHardDeleteAction(client: BotClient, guildId: string, discordUserId: string): Promise<string> {
    const user = await getUserByDiscordId(guildId, discordUserId);
    if (!user) throw new BiomeHuntError("That user has no data to delete.");

    const deleted = await deleteUserCascade(user.id);
    if (deleted) await deleteDiscordChannel(client, deleted.channelId);
    return `<@${discordUserId}>'s data has been fully wiped. They can run \`/bh setup\` again.`;
}

/** Removes the macro channel/webhook and all session history, but keeps badges and quota status. */
export async function memberSoftDeleteAction(client: BotClient, guildId: string, discordUserId: string): Promise<string> {
    const user = await getUserByDiscordId(guildId, discordUserId);
    if (!user) throw new BiomeHuntError("That user has no data.");

    const deleted = await deleteMacroChannelOnly(user.id);
    const sessionsRemoved = await deleteAllSessionsForUser(user.id);
    if (deleted) await deleteDiscordChannel(client, deleted.channelId);

    return `<@${discordUserId}>: macro channel removed and ${sessionsRemoved} session(s) cleared. Badges and quota status kept. They can run \`/bh setup\` again.`;
}

/** Removes only the macro channel/webhook - all history, badges, and quota status stay untouched. */
export async function memberResetChannelAction(client: BotClient, guildId: string, discordUserId: string): Promise<string> {
    const user = await getUserByDiscordId(guildId, discordUserId);
    if (!user) throw new BiomeHuntError("That user has no data.");

    const deleted = await deleteMacroChannelOnly(user.id);
    if (!deleted) throw new BiomeHuntError("That user doesn't have a macro channel.");
    await deleteDiscordChannel(client, deleted.channelId);

    return `<@${discordUserId}>'s macro channel removed. All other data kept. They can run \`/bh setup\` again.`;
}

export async function pauseUserAction(guildId: string, discordUserId: string): Promise<string> {
    const paused = await pauseUser(guildId, discordUserId);
    if (!paused) throw new BiomeHuntError("That user has no data.");
    return `<@${discordUserId}> is now exempt from inactivity auto-delete.`;
}

export async function unpauseUserAction(guildId: string, discordUserId: string): Promise<string> {
    const unpaused = await unpauseUser(guildId, discordUserId);
    if (!unpaused) throw new BiomeHuntError("That user has no data.");
    return `<@${discordUserId}> is no longer exempt from inactivity auto-delete.`;
}

export async function memberDecrementBiomeAction(guildId: string, discordUserId: string, biome: string, amount: number): Promise<string> {
    if (amount <= 0) throw new BiomeHuntError("Amount must be greater than zero.");
    const user = await getUserByDiscordId(guildId, discordUserId);
    if (!user) throw new BiomeHuntError("That user has no profile yet.");

    const removed = await decrementBiomeEvents(user.id, biome, amount);
    if (removed === 0) throw new BiomeHuntError(`<@${discordUserId}> has no recorded finds for ${formatBiomeName(biome)}.`);
    return `Removed ${removed} recorded find(s) of ${formatBiomeName(biome)} for <@${discordUserId}>.`;
}

export async function memberClearBiomesAction(guildId: string, discordUserId: string, biome: string): Promise<string> {
    const user = await getUserByDiscordId(guildId, discordUserId);
    if (!user) throw new BiomeHuntError("That user has no profile yet.");

    const removed = await clearBiomeEvents(user.id, biome);
    if (removed === 0) throw new BiomeHuntError(`<@${discordUserId}> has no recorded events for ${formatBiomeName(biome)}.`);
    return `Cleared all ${formatBiomeName(biome)} records for <@${discordUserId}> (${removed} event(s) removed).`;
}
