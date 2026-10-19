import type { Guild } from "discord.js";

/** False when the role is managed, missing, or not below the bot's highest role. */
export function canBotAssignRole(guild: Guild, roleId: string): boolean {
    const role = guild.roles.cache.get(roleId);
    const me = guild.members.me;
    if (!role || !me || role.managed) return false;
    return me.roles.highest.comparePositionTo(role) > 0;
}
