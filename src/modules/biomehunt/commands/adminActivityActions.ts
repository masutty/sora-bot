import { resetThresholds, setAutoDeleteHours, setGuildRoleForStatus, updateThresholds } from "../repository/guilds";
import { BiomeHuntError, type ActivityStatus } from "../types";

export async function activitySetAction(
    guildId: string,
    sessionGapMinutes: number,
    idleMinutes: number,
    inactiveHours: number,
): Promise<string> {
    if (sessionGapMinutes <= 0 || idleMinutes <= 0 || inactiveHours <= 0) {
        throw new BiomeHuntError("All thresholds must be greater than zero.");
    }
    await updateThresholds(guildId, sessionGapMinutes * 60, idleMinutes * 60, inactiveHours * 3600);
    return `Thresholds updated: session gap ${sessionGapMinutes}m, idle ${idleMinutes}m, inactive ${inactiveHours}h.`;
}

export async function activityResetAction(guildId: string): Promise<string> {
    await resetThresholds(guildId);
    return "Thresholds reset to defaults (session gap 20m, idle 30m, inactive 24h).";
}

/** Sets the auto-delete hours-after-inactive threshold. This alone doesn't enable auto-delete - see the AUTO_DELETE_ENABLED flag. */
export async function activityDeleteAction(guildId: string, hoursAfterInactive: number): Promise<string> {
    if (hoursAfterInactive <= 0) throw new BiomeHuntError("Hours must be greater than zero.");
    await setAutoDeleteHours(guildId, Math.round(hoursAfterInactive * 3600));
    return `Auto-delete threshold set: a user's macro channel is removed ${hoursAfterInactive}h after they go inactive. ` +
        "Remember this only takes effect while the AUTO_DELETE_ENABLED flag is on (`flag set flag:AUTO_DELETE_ENABLED enabled:true`).";
}

/** `roleId` of `null` unsets that status's role instead of setting one. */
export async function activitySetRoleAction(guildId: string, status: ActivityStatus, roleId: string | null): Promise<string> {
    await setGuildRoleForStatus(guildId, status, roleId);
    if (!roleId) return `The ${status} role has been unset.`;
    return `The ${status} role is now <@&${roleId}>.`;
}
