import { ContainerBuilder } from "discord.js";
import { DELETED_BADGE, getBadgeMeta, getRoleBadges } from "../constants/badges.constants";
import {
    getGuildBadgeRole,
    getGuildBadgeRoles,
    grantUserBadge,
    removeGuildBadgeRole,
    revokeUserBadge,
    setGuildBadgeRole,
} from "../repository/badges.repository";
import { enqueueRoleJob } from "../repository/role-jobs.repository";
import { getUserByDiscordId } from "../repository/users.repository";
import { type Badge, BiomeHuntError } from "../types";

export async function awardBadge(guildId: string, discordUserId: string, badge: Badge): Promise<string> {
    const user = await getUserByDiscordId(guildId, discordUserId);
    if (!user) throw new BiomeHuntError("That user has no profile yet.");

    const granted = await grantUserBadge(user.id, badge);
    if (!granted) return `<@${discordUserId}> already has the ${getBadgeMeta(badge).display} badge.`;

    const roleId = await getGuildBadgeRole(guildId, badge);
    if (roleId) await enqueueRoleJob(guildId, user.id, roleId, "add");

    return `${getBadgeMeta(badge).emoji} <@${discordUserId}> was granted the ${getBadgeMeta(badge).display} badge.`;
}

export async function takeBadge(guildId: string, discordUserId: string, badge: Badge): Promise<string> {
    const user = await getUserByDiscordId(guildId, discordUserId);
    if (!user) throw new BiomeHuntError("That user has no profile yet.");

    const revoked = await revokeUserBadge(user.id, badge);
    if (!revoked) return `<@${discordUserId}> doesn't have the ${getBadgeMeta(badge).display} badge.`;

    const roleId = await getGuildBadgeRole(guildId, badge);
    if (roleId) await enqueueRoleJob(guildId, user.id, roleId, "remove");

    return `${getBadgeMeta(badge).display} badge removed from <@${discordUserId}>.`;
}

/** `roleId` of `null` unconfigures the badge's role instead of setting one. */
export async function setBadges(guildId: string, badge: Badge, roleId: string | null): Promise<string> {
    if (!roleId) {
        await removeGuildBadgeRole(guildId, badge);
        return `${getBadgeMeta(badge).emoji} ${getBadgeMeta(badge).display} no longer grants a role.`;
    }
    if (!getRoleBadges().includes(badge)) throw new BiomeHuntError(`${getBadgeMeta(badge).display} can't grant a role.`);
    await setGuildBadgeRole(guildId, badge, roleId);
    return `${getBadgeMeta(badge).emoji} ${getBadgeMeta(badge).display} will now grant <@&${roleId}>.`;
}

export async function listBadges(guildId: string): Promise<ContainerBuilder> {
    const badgeRoles = await getGuildBadgeRoles(guildId);
    const badgeRoleMap = new Map(badgeRoles.map((b) => [b.badge, b.role_id]));

    const finderLines = getRoleBadges().map((badge) => {
        const roleId = badgeRoleMap.get(badge);
        return `${getBadgeMeta(badge).emoji} ${getBadgeMeta(badge).display}: ${roleId ? `<@&${roleId}>` : "not set"}`;
    });
    const deleted = getBadgeMeta(DELETED_BADGE);
    const lines = [...finderLines, `${deleted.emoji} ${deleted.display}: not configurable`];

    const container = new ContainerBuilder().setAccentColor(0x5865f2);
    container.addTextDisplayComponents((td) => td.setContent(`**Badges**\n${lines.join("\n")}`));
    return container;
}
