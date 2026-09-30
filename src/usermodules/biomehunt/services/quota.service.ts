import { ContainerBuilder } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { markQuotaEvaluated, updateQuotaEvalHour } from "../repository/guilds.repository";
import { deleteQuotaRole, getQuotaRolesForGuild, upsertQuotaRole } from "../repository/quota-roles.repository";
import { BiomeHuntError, type QuotaRoleMode, type QuotaRoleRow } from "../types";
import { evaluateFixedRewardsForGuild } from "./reward.service";

function formatQuotaRoleLine(r: QuotaRoleRow): string {
    const modeLabel = r.mode === "F" ? "Fixed" : "Rolling Window";
    const durationNote = r.mode === "F" ? `, ${r.access_duration_days}d access` : "";
    return `<@&${r.role_id}> - ${modeLabel}: ${r.quota_target_seconds / 3600}h / ${r.quota_window_hours}h window${durationNote}`;
}

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

    await upsertQuotaRole(guildId, roleId, mode, Math.round(quotaHours * 3600), quotaWindowHours, mode === "F" ? accessDurationDays : null);

    const modeLabel = mode === "F" ? "Fixed" : "Rolling Window";
    const durationNote = mode === "F" ? `, ${accessDurationDays} day(s) access` : "";
    return `Quota role <@&${roleId}> created: ${modeLabel} mode, ${quotaHours}h within a ${quotaWindowHours}h window${durationNote}.`;
}

export async function removeQuotaRole(guildId: string, roleId: string): Promise<string> {
    const removed = await deleteQuotaRole(guildId, roleId);
    if (!removed) throw new BiomeHuntError("That quota role isn't configured.");
    return `Quota role <@&${roleId}> removed. Members who already hold it keep it until it expires (Fixed mode) or is removed manually.`;
}

export async function listQuotas(guildId: string): Promise<ContainerBuilder> {
    const roles = await getQuotaRolesForGuild(guildId);
    const container = new ContainerBuilder().setAccentColor(0x5865f2);

    if (roles.length === 0) {
        container.addTextDisplayComponents((td) => td.setContent("**Quotas**\nNo quota roles configured yet."));
        return container;
    }

    container.addTextDisplayComponents((td) => td.setContent(`**Quotas**\n${roles.map(formatQuotaRoleLine).join("\n")}`));
    return container;
}

export async function setQuotaEvalHour(guildId: string, hourUtc: number): Promise<string> {
    if (hourUtc < 0 || hourUtc > 23) throw new BiomeHuntError("Hour must be between 0 and 23.");
    await updateQuotaEvalHour(guildId, hourUtc);
    return `Fixed-mode quota rewards will now be evaluated daily at ${hourUtc}:00 UTC.`;
}

export async function forceQuotaEval(client: BotClient, guildId: string): Promise<string> {
    const count = await evaluateFixedRewardsForGuild(client, guildId);
    if (count === 0) throw new BiomeHuntError("No Fixed-mode quota reward roles are configured for this server.");
    await markQuotaEvaluated(guildId);
    return `Fixed-mode quota rewards evaluated now for ${count} configured role(s).`;
}
