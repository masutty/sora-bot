/** The part of a guild member the hierarchy check reads. */
export interface RankedMember {
    id: string;
    roles: { highest: { position: number } };
}

export interface HierarchyInput {
    ownerId: string;
    /** The bot's own member. */
    me: RankedMember;
    /** Who acts; `null` is the bot itself. */
    actor: RankedMember | null;
    targetId: string;
    /** `null` when the target is not in the server (only the id checks apply). */
    target: RankedMember | null;
}

/**
 * Why `actor` may not act on `target` (kick, ban, mute, role changes...), or `null` when it may.
 * Nobody acts on themselves, the server owner or the bot; the actor (unless it owns the server)
 * and the bot must both have a highest role above the target's.
 */
export function hierarchyRefusal({ ownerId, me, actor, targetId, target }: HierarchyInput): string | null {
    const actorId = actor?.id ?? me.id;
    if (targetId === actorId) return "You can't do that to yourself.";
    if (targetId === me.id) return "I can't do that to myself.";
    if (targetId === ownerId) return "You can't do that to the server owner.";
    if (!target) return null;
    if (actor && actor.id !== ownerId && actor.roles.highest.position <= target.roles.highest.position) {
        return "Your highest role is not above theirs.";
    }
    if (me.roles.highest.position <= target.roles.highest.position) return "My highest role is not above theirs.";
    return null;
}

/** The warning line for a role the bot cannot give, or null when it can. */
export function roleProblem(
    role: { managed: boolean; id: string; position: number } | null,
    guildId: string,
    botTopPosition: number,
    botCanManageRoles: boolean,
): string | null {
    if (!role) return "⚠️ That role no longer exists.";
    if (role.managed || role.id === guildId || role.position >= botTopPosition)
        return `⚠️ The bot can't give <@&${role.id}> - move the bot's role above it.`;
    if (!botCanManageRoles) return `⚠️ The bot needs Manage Roles to give <@&${role.id}>.`;
    return null;
}
