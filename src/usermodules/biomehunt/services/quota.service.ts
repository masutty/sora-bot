import type { BotClient } from "@/core/bot-client";
import { markQuotaEvaluated } from "../repository/guilds.repository";
import { deleteQuotaRole, upsertQuotaRole } from "../repository/quota-roles.repository";
import { BiomeHuntError, type QuotaRoleMode } from "../types";
import { evaluateFixedRewardsForGuild } from "./reward.service";

/* Fixed mode is a daily reward, so its window is always 24h. */
const DAILY_WINDOW_HOURS = 24;

export async function createQuota(
    guildId: string,
    roleId: string,
    mode: QuotaRoleMode,
    quotaHours: number,
    quotaWindowHours: number,
    accessDurationDays: number | null,
): Promise<string> {
    if (mode !== "F" && mode !== "RW") {
        throw new BiomeHuntError("mode must be either F (Fixed) or RW (Rolling Window).");
    }
    if (quotaHours <= 0 || quotaWindowHours <= 0) {
        throw new BiomeHuntError("Quota hours and window must be greater than zero.");
    }
    if (mode === "F" && (!accessDurationDays || accessDurationDays <= 0)) {
        throw new BiomeHuntError("access_duration_days is required and must be greater than zero when mode is F.");
    }
    if (mode === "RW" && accessDurationDays !== null) {
        throw new BiomeHuntError("access_duration_days isn't used in RW mode - omit it.");
    }

    const windowHours = mode === "F" ? DAILY_WINDOW_HOURS : quotaWindowHours;
    await upsertQuotaRole(guildId, roleId, mode, Math.round(quotaHours * 3600), windowHours, mode === "F" ? accessDurationDays : null);

    const modeLabel = mode === "F" ? "Fixed" : "Rolling Window";
    const durationNote = mode === "F" ? `, ${accessDurationDays} day(s) access` : "";
    return `Quota role <@&${roleId}> created: ${modeLabel} mode, ${quotaHours}h within a ${windowHours}h window${durationNote}.`;
}

export async function removeQuotaRole(guildId: string, roleId: string): Promise<string> {
    const removed = await deleteQuotaRole(guildId, roleId);
    if (!removed) throw new BiomeHuntError("That quota role isn't configured.");
    return `Quota role <@&${roleId}> removed. Members who already hold it keep it until it expires (Fixed mode) or is removed manually.`;
}

export async function forceQuotaEval(client: BotClient, guildId: string): Promise<string> {
    const count = await evaluateFixedRewardsForGuild(client, guildId);
    if (count === 0) throw new BiomeHuntError("No Fixed-mode quota reward roles are configured for this server.");
    await markQuotaEvaluated(guildId);
    return `Fixed-mode quota rewards evaluated now for ${count} configured role(s).`;
}
