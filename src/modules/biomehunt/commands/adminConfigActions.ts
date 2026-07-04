import { EmbedBuilder } from "discord.js";
import type { BotClient } from "@/core/BotClient";
import { formatTime } from "@/utils/format";
import {
    addCategory, clearGuildRoles, disableCounter, getEnabledCategories, getGuildRoles, getOrCreateGuildConfig,
    isGuildReady, markQuotaEvaluated, removeCategory, resetGuildConfig, resetThresholds, setAutoCreateCategories,
    setAutoDeleteAfter, setCounterChannel, setGuildRoles, setQuotaEvalHour, updateThresholds,
} from "../repository/guilds";
import { getGuildBadgeRoles, setGuildBadgeRole, clearGuildBadgeRoles } from "../repository/badges";
import { getQuotaRolesForGuild, removeQuotaRole, upsertQuotaRole } from "../repository/quotaRoles";
import { evaluateFixedRewardsForGuild } from "../services/RewardEngine";
import { ALL_BADGES, BADGE_META, BiomeHuntError, type Badge, type QuotaRoleMode } from "../types";
import { updateCounterForGuild } from "../workers/CounterEngine";

export async function showConfig(guildId: string): Promise<EmbedBuilder> {
    const config = await getOrCreateGuildConfig(guildId);
    const roles = await getGuildRoles(guildId);
    const categories = await getEnabledCategories(guildId);
    const badgeRoles = await getGuildBadgeRoles(guildId);

    const badgeRoleMap = new Map(badgeRoles.map((b) => [b.badge, b.role_id]));
    const badgeLines = ALL_BADGES.map((badge) => {
        const roleId = badgeRoleMap.get(badge);
        return `${BADGE_META[badge].emoji} ${BADGE_META[badge].label}: ${roleId ? `<@&${roleId}>` : "not set"}`;
    });

    return new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("BiomeHunt Configuration")
        .addFields(
            {
                name: "Thresholds",
                value: `Session gap: ${formatTime(config.session_gap_threshold_s)}\nIdle: ${formatTime(config.idle_threshold_s)}\nInactive: ${formatTime(config.inactive_threshold_s)}`,
            },
            { name: "Categories", value: categories.length > 0 ? categories.map((c) => `<#${c.discord_category_id}>`).join(", ") : "None" },
            {
                name: "Roles",
                value: `Active: ${roles.active ? `<@&${roles.active}>` : "not set"}\nIdle: ${roles.idle ? `<@&${roles.idle}>` : "not set"}\nInactive: ${roles.inactive ? `<@&${roles.inactive}>` : "not set"}`,
            },
            { name: "Special Biome Roles", value: badgeLines.join("\n") },
            { name: "Auto-create categories", value: config.auto_create_categories ? "Enabled" : "Disabled", inline: true },
            { name: "Auto-delete inactive users", value: config.delete_inactive_after_s ? formatTime(config.delete_inactive_after_s) : "Disabled", inline: true },
            { name: "Live counter", value: config.counter_channel_id ? `<#${config.counter_channel_id}>` : "Disabled", inline: true },
        );
}

export async function setThresholdsAction(
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

export async function resetThresholdsAction(guildId: string): Promise<string> {
    await resetThresholds(guildId);
    return "Thresholds reset to defaults (session gap 20m, idle 30m, inactive 24h).";
}

export async function setAutoDeleteAction(guildId: string, hoursAfterInactive: number): Promise<string> {
    if (hoursAfterInactive <= 0) throw new BiomeHuntError("Hours must be greater than zero.");
    await setAutoDeleteAfter(guildId, Math.round(hoursAfterInactive * 3600));
    return `Auto-delete enabled: a user's macro channel is removed ${hoursAfterInactive}h after they go inactive.`;
}

export async function disableAutoDeleteAction(guildId: string): Promise<string> {
    await setAutoDeleteAfter(guildId, null);
    return "Auto-delete disabled. Inactive users' channels are no longer removed automatically.";
}

export async function setAutoCreateCategoriesAction(guildId: string, enabled: boolean): Promise<string> {
    await setAutoCreateCategories(guildId, enabled);
    return `Auto-create categories ${enabled ? "enabled" : "disabled"}.`;
}

export async function addCategoryAction(guildId: string, categoryId: string): Promise<string> {
    await addCategory(guildId, categoryId);
    return `Category <#${categoryId}> is now allowed for macro channels.`;
}

export async function removeCategoryAction(guildId: string, categoryId: string): Promise<string> {
    const removed = await removeCategory(guildId, categoryId);
    if (!removed) throw new BiomeHuntError("That category isn't registered.");
    return `Category <#${categoryId}> removed.`;
}

export async function setRolesAction(guildId: string, activeId: string, idleId: string, inactiveId: string): Promise<string> {
    await setGuildRoles(guildId, activeId, idleId, inactiveId);
    return `Roles updated: active <@&${activeId}>, idle <@&${idleId}>, inactive <@&${inactiveId}>.`;
}

export async function clearRolesAction(guildId: string): Promise<string> {
    await clearGuildRoles(guildId);
    return "All status roles have been cleared.";
}

export async function setCounterChannelAction(guildId: string, channelId: string): Promise<string> {
    await setCounterChannel(guildId, channelId);
    return `Live counter will now be posted in <#${channelId}>.`;
}

export async function disableCounterAction(guildId: string): Promise<string> {
    await disableCounter(guildId);
    return "Live counter disabled.";
}

export async function forceCounterUpdateAction(client: BotClient, guildId: string): Promise<string> {
    const guildConfig = await getOrCreateGuildConfig(guildId);
    if (!guildConfig.counter_channel_id) {
        throw new BiomeHuntError("Live counter isn't configured for this server. Set one with `counter set-channel`.");
    }
    await updateCounterForGuild(client, guildConfig);
    return `Live counter updated in <#${guildConfig.counter_channel_id}>.`;
}

export async function testConfigAction(guildId: string): Promise<EmbedBuilder> {
    const { hasCategory, hasRoles } = await isGuildReady(guildId);
    const config = await getOrCreateGuildConfig(guildId);
    const ready = hasCategory && hasRoles;

    const lines = [
        `${hasCategory ? "✅" : "❌"} At least one enabled category`,
        `${hasRoles ? "✅" : "❌"} All 3 status roles configured`,
        `✅ Thresholds: gap=${formatTime(config.session_gap_threshold_s)} idle=${formatTime(config.idle_threshold_s)} inactive=${formatTime(config.inactive_threshold_s)}`,
        `ℹ️ Live counter: ${config.counter_channel_id ? "enabled (optional)" : "disabled (optional)"}`,
    ];

    return new EmbedBuilder()
        .setColor(ready ? 0x57f287 : 0xed4245)
        .setTitle("BiomeHunt Configuration Check")
        .setDescription(lines.join("\n"))
        .setFooter({ text: ready ? "System ready — /bh setup is enabled." : "System incomplete — /bh setup is blocked until required items are set." });
}

export async function resetConfigAction(guildId: string): Promise<string> {
    await resetGuildConfig(guildId);
    return "All BiomeHunt configuration for this server has been reset.";
}

export async function setQuotaRoleAction(
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
    return `Quota role <@&${roleId}> set: ${modeLabel} mode, ${quotaHours}h within a ${quotaWindowHours}h window${durationNote}.`;
}

export async function removeQuotaRoleAction(guildId: string, roleId: string): Promise<string> {
    const removed = await removeQuotaRole(guildId, roleId);
    if (!removed) throw new BiomeHuntError("That quota role isn't configured.");
    return `Quota role <@&${roleId}> removed. Members who already hold it keep it until it expires (Fixed mode) or is removed manually.`;
}

export async function listQuotaRolesAction(guildId: string): Promise<EmbedBuilder> {
    const roles = await getQuotaRolesForGuild(guildId);
    const embed = new EmbedBuilder().setColor(0x5865f2).setTitle("BiomeHunt Quota Roles");

    if (roles.length === 0) {
        embed.setDescription("No quota roles configured yet.");
        return embed;
    }

    const lines = roles.map((r) => {
        const modeLabel = r.mode === "F" ? "Fixed" : "Rolling Window";
        const durationNote = r.mode === "F" ? `, ${r.access_duration_days}d access` : "";
        return `<@&${r.role_id}> — ${modeLabel}: ${r.quota_target_seconds / 3600}h / ${r.quota_window_hours}h window${durationNote}`;
    });
    embed.setDescription(lines.join("\n"));
    return embed;
}

export async function setQuotaEvalHourAction(guildId: string, hourUtc: number): Promise<string> {
    if (hourUtc < 0 || hourUtc > 23) throw new BiomeHuntError("Hour must be between 0 and 23.");
    await setQuotaEvalHour(guildId, hourUtc);
    return `Fixed-mode quota rewards will now be evaluated daily at ${hourUtc}:00 UTC.`;
}

export async function forceQuotaEvalAction(guildId: string): Promise<string> {
    const count = await evaluateFixedRewardsForGuild(guildId);
    if (count === 0) throw new BiomeHuntError("No Fixed-mode quota reward roles are configured for this server.");
    await markQuotaEvaluated(guildId);
    return `Fixed-mode quota rewards evaluated now for ${count} configured role(s).`;
}

export async function setBadgeRoleAction(guildId: string, badge: Badge, roleId: string): Promise<string> {
    await setGuildBadgeRole(guildId, badge, roleId);
    return `${BADGE_META[badge].emoji} ${BADGE_META[badge].label} will now grant <@&${roleId}>.`;
}

export async function clearBadgeRolesAction(guildId: string): Promise<string> {
    await clearGuildBadgeRoles(guildId);
    return "All special biome badge role configurations have been cleared.";
}
