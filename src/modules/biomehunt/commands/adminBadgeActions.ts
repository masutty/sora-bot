import { EmbedBuilder } from "discord.js";
import { getGuildBadgeRole, getGuildBadgeRoles, grantUserBadge, removeGuildBadgeRole, revokeUserBadge, setGuildBadgeRole } from "../repository/badges";
import { enqueueRoleJob } from "../repository/roleJobs";
import { getUserByDiscordId } from "../repository/users";
import { ALL_BADGES, BADGE_META, BiomeHuntError, type Badge } from "../types";

export async function badgesAwardAction(guildId: string, discordUserId: string, badge: Badge): Promise<string> {
    const user = await getUserByDiscordId(guildId, discordUserId);
    if (!user) throw new BiomeHuntError("That user has no profile yet.");

    const granted = await grantUserBadge(user.id, badge);
    if (!granted) return `<@${discordUserId}> already has the ${BADGE_META[badge].display} badge.`;

    const roleId = await getGuildBadgeRole(guildId, badge);
    if (roleId) await enqueueRoleJob(guildId, user.id, roleId, "add");

    return `${BADGE_META[badge].emoji} <@${discordUserId}> was granted the ${BADGE_META[badge].display} badge.`;
}

export async function badgesTakeAction(guildId: string, discordUserId: string, badge: Badge): Promise<string> {
    const user = await getUserByDiscordId(guildId, discordUserId);
    if (!user) throw new BiomeHuntError("That user has no profile yet.");

    const revoked = await revokeUserBadge(user.id, badge);
    if (!revoked) return `<@${discordUserId}> doesn't have the ${BADGE_META[badge].display} badge.`;

    const roleId = await getGuildBadgeRole(guildId, badge);
    if (roleId) await enqueueRoleJob(guildId, user.id, roleId, "remove");

    return `${BADGE_META[badge].display} badge removed from <@${discordUserId}>.`;
}

/** `roleId` of `null` unconfigures the badge's role instead of setting one. */
export async function badgesSetAction(guildId: string, badge: Badge, roleId: string | null): Promise<string> {
    if (!roleId) {
        await removeGuildBadgeRole(guildId, badge);
        return `${BADGE_META[badge].emoji} ${BADGE_META[badge].display} no longer grants a role.`;
    }
    await setGuildBadgeRole(guildId, badge, roleId);
    return `${BADGE_META[badge].emoji} ${BADGE_META[badge].display} will now grant <@&${roleId}>.`;
}

export async function badgesListAction(guildId: string): Promise<EmbedBuilder> {
    const badgeRoles = await getGuildBadgeRoles(guildId);
    const badgeRoleMap = new Map(badgeRoles.map((b) => [b.badge, b.role_id]));

    const allBadges = Object.keys(BADGE_META) as Badge[];
    const lines = allBadges.map((badge) => {
        const isConfigurable = (ALL_BADGES as string[]).includes(badge);
        const roleNote = isConfigurable ? (badgeRoleMap.get(badge) ? `<@&${badgeRoleMap.get(badge)}>` : "not set") : "not configurable";
        return `${BADGE_META[badge].emoji} ${BADGE_META[badge].display}: ${roleNote}`;
    });

    return new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("BiomeHunt Badges")
        .setDescription(lines.join("\n"));
}
