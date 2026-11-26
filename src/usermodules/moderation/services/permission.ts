import { PermissionFlagsBits } from "discord.js";
import { ModerationError, type ModSettings } from "../types";

/** The native permission a moderation action needs while no moderator role is set. */
export type ModAction = "moderate" | "kick" | "ban";

const NATIVE: Record<ModAction, bigint> = {
    moderate: PermissionFlagsBits.ModerateMembers,
    kick: PermissionFlagsBits.KickMembers,
    ban: PermissionFlagsBits.BanMembers,
};

/** A guild member as slash, prefix and component interactions give it (role list or role manager). */
export interface ModMember {
    permissions: { has(permission: bigint): boolean } | null;
    roles?: string[] | { cache: { has(id: string): boolean } };
}

const hasRole = (member: ModMember, roleId: string) =>
    Array.isArray(member.roles) ? member.roles.includes(roleId) : (member.roles?.cache.has(roleId) ?? false);

/** With a moderator role set: that role or Administrator. Without: the native permission of the action. */
export function canModerate(member: ModMember, action: ModAction, settings: Pick<ModSettings, "moderator_role_id">): boolean {
    const permissions = member.permissions;
    if (settings.moderator_role_id) {
        return (permissions?.has(PermissionFlagsBits.Administrator) ?? false) || hasRole(member, settings.moderator_role_id);
    }
    return permissions?.has(NATIVE[action]) ?? false;
}

export function assertCanModerate(member: ModMember, action: ModAction, settings: Pick<ModSettings, "moderator_role_id">): void {
    if (!canModerate(member, action, settings)) {
        throw new ModerationError(
            settings.moderator_role_id
                ? `You need the <@&${settings.moderator_role_id}> role to do that.`
                : "You don't have permission to do that.",
        );
    }
}

/** `moderator settings`: Administrator or Manage Server, never the moderator role. */
export const canManageSettings = (member: ModMember): boolean => member.permissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
