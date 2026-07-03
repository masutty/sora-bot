import { EmbedBuilder } from "discord.js";
import { formatTime } from "@/utils/format";
import {
    addCategory, clearGuildRoles, disableCounter, getEnabledCategories, getGuildRoles, getOrCreateGuildConfig,
    isGuildReady, removeCategory, resetGuildConfig, resetQuota, resetThresholds, setAutoCreateCategories,
    setCounterChannel, setGuildRoles, updateQuota, updateThresholds,
} from "../repository/guilds";
import { BiomeHuntError } from "../types";

export async function showConfig(guildId: string): Promise<EmbedBuilder> {
    const config = await getOrCreateGuildConfig(guildId);
    const roles = await getGuildRoles(guildId);
    const categories = await getEnabledCategories(guildId);

    return new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("BiomeHunt Configuration")
        .addFields(
            {
                name: "Thresholds",
                value: `Session gap: ${formatTime(config.session_gap_threshold_s)}\nIdle: ${formatTime(config.idle_threshold_s)}\nInactive: ${formatTime(config.inactive_threshold_s)}`,
            },
            { name: "Quota", value: `${formatTime(config.quota_target_seconds)} within a ${config.quota_window_hours}h window` },
            { name: "Categories", value: categories.length > 0 ? categories.map((c) => `<#${c.discord_category_id}>`).join(", ") : "None" },
            {
                name: "Roles",
                value: `Active: ${roles.active ? `<@&${roles.active}>` : "not set"}\nIdle: ${roles.idle ? `<@&${roles.idle}>` : "not set"}\nInactive: ${roles.inactive ? `<@&${roles.inactive}>` : "not set"}`,
            },
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

export async function setQuotaAction(guildId: string, windowHours: number, targetHours: number): Promise<string> {
    if (windowHours <= 0 || targetHours <= 0) throw new BiomeHuntError("Quota window and target must be greater than zero.");
    await updateQuota(guildId, windowHours, Math.round(targetHours * 3600));
    return `Quota updated: ${targetHours}h required within a ${windowHours}h window.`;
}

export async function resetQuotaAction(guildId: string): Promise<string> {
    await resetQuota(guildId);
    return "Quota reset to default (6h within a 24h window).";
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

export async function testConfigAction(guildId: string): Promise<EmbedBuilder> {
    const { hasCategory, hasRoles } = await isGuildReady(guildId);
    const config = await getOrCreateGuildConfig(guildId);
    const ready = hasCategory && hasRoles;

    const lines = [
        `${hasCategory ? "✅" : "❌"} At least one enabled category`,
        `${hasRoles ? "✅" : "❌"} All 3 status roles configured`,
        `✅ Thresholds: gap=${formatTime(config.session_gap_threshold_s)} idle=${formatTime(config.idle_threshold_s)} inactive=${formatTime(config.inactive_threshold_s)}`,
        `✅ Quota: ${formatTime(config.quota_target_seconds)} / ${config.quota_window_hours}h`,
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
