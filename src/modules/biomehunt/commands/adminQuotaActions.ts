import { EmbedBuilder } from "discord.js";
import type { ActionRowBuilder, ButtonBuilder, GuildTextBasedChannel, Message } from "discord.js";
import type { BotClient } from "@/core/BotClient";
import { EmbedFormatter } from "@/utils/format";
import { markQuotaEvaluated, setQuotaEvalHour } from "../repository/guilds";
import { getQuotaRolesForGuild, removeQuotaRole, upsertQuotaRole } from "../repository/quotaRoles";
import { evaluateFixedRewardsForGuild } from "../services/RewardEngine";
import { BiomeHuntError, type QuotaRoleMode, type QuotaRoleRow } from "../types";

function formatQuotaRoleLine(r: QuotaRoleRow): string {
    const modeLabel = r.mode === "F" ? "Fixed" : "Rolling Window";
    const durationNote = r.mode === "F" ? `, ${r.access_duration_days}d access` : "";
    return `<@&${r.role_id}> — ${modeLabel}: ${r.quota_target_seconds / 3600}h / ${r.quota_window_hours}h window${durationNote}`;
}

export async function quotasCreateAction(
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
        throw new BiomeHuntError("access_duration_days isn't used in RW mode — omit it.");
    }

    await upsertQuotaRole(guildId, roleId, mode, Math.round(quotaHours * 3600), quotaWindowHours, mode === "F" ? accessDurationDays : null);

    const modeLabel = mode === "F" ? "Fixed" : "Rolling Window";
    const durationNote = mode === "F" ? `, ${accessDurationDays} day(s) access` : "";
    return `Quota role <@&${roleId}> created: ${modeLabel} mode, ${quotaHours}h within a ${quotaWindowHours}h window${durationNote}.`;
}

export async function removeQuotaRoleAction(guildId: string, roleId: string): Promise<string> {
    const removed = await removeQuotaRole(guildId, roleId);
    if (!removed) throw new BiomeHuntError("That quota role isn't configured.");
    return `Quota role <@&${roleId}> removed. Members who already hold it keep it until it expires (Fixed mode) or is removed manually.`;
}

/**
 * `roleId` given -> deletes it directly. `roleId` omitted -> shows a numbered list (mirroring
 * ez-setup's quota role removal screen) and waits for the admin to type the number to delete.
 */
export async function runQuotasDelete(
    guildId: string,
    roleId: string | null,
    invokerId: string,
    respond: (payload: { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] }) => Promise<Message>,
): Promise<void> {
    if (roleId) {
        const message = await removeQuotaRoleAction(guildId, roleId);
        await respond({ embeds: [EmbedFormatter.success(message)], components: [] });
        return;
    }

    const roles = await getQuotaRolesForGuild(guildId);
    if (roles.length === 0) {
        await respond({ embeds: [EmbedFormatter.info("No quota roles configured yet.")], components: [] });
        return;
    }

    const lines = roles.map((r, i) => `${i + 1}. ${formatQuotaRoleLine(r)}`);
    const msg = await respond({
        embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle("Delete Quota Role").setDescription(`Type the number of the quota role you want to delete:\n\n${lines.join("\n")}`)],
        components: [],
    });

    const channel = msg.channel as GuildTextBasedChannel;
    const collector = channel.createMessageCollector({ filter: (m) => m.author.id === invokerId, time: 60_000, max: 1 });

    collector.on("collect", async (m) => {
        const n = Number(m.content.trim());
        if (!Number.isInteger(n) || n < 1 || n > roles.length) {
            await m.reply(`Please type a number between 1 and ${roles.length}.`).catch(() => {});
            return;
        }
        const target = roles[n - 1];
        const message = await removeQuotaRoleAction(guildId, target.role_id);
        await msg.edit({ embeds: [EmbedFormatter.success(message)] }).catch(() => {});
    });

    collector.on("end", (collected) => {
        if (collected.size === 0) msg.edit({ embeds: [EmbedFormatter.info("Timed out, nothing removed.")] }).catch(() => {});
    });
}

export async function quotasListAction(guildId: string): Promise<EmbedBuilder> {
    const roles = await getQuotaRolesForGuild(guildId);
    const embed = new EmbedBuilder().setColor(0x5865f2).setTitle("BiomeHunt Quotas");

    if (roles.length === 0) {
        embed.setDescription("No quota roles configured yet.");
        return embed;
    }

    embed.setDescription(roles.map(formatQuotaRoleLine).join("\n"));
    return embed;
}

export async function quotasSetEvalHourAction(guildId: string, hourUtc: number): Promise<string> {
    if (hourUtc < 0 || hourUtc > 23) throw new BiomeHuntError("Hour must be between 0 and 23.");
    await setQuotaEvalHour(guildId, hourUtc);
    return `Fixed-mode quota rewards will now be evaluated daily at ${hourUtc}:00 UTC.`;
}

export async function quotasForceEvalAction(client: BotClient, guildId: string): Promise<string> {
    const count = await evaluateFixedRewardsForGuild(client, guildId);
    if (count === 0) throw new BiomeHuntError("No Fixed-mode quota reward roles are configured for this server.");
    await markQuotaEvaluated(guildId);
    return `Fixed-mode quota rewards evaluated now for ${count} configured role(s).`;
}
