import { EmbedBuilder } from "discord.js";
import type { BotClient } from "@/core/BotClient";
import { formatTime } from "@/utils/format";
import {
    addCategory, disableCounter, getEnabledCategories, getGuildRoles, getOrCreateGuildConfig,
    isGuildReady, removeCategory, resetGuildConfig, setAutoCreateCategories, setCounterChannel, setGuildRoles,
} from "../repository/guilds";
import { getGuildBadgeRoles } from "../repository/badges";
import { isFlagEnabled } from "../repository/flags";
import { getForwardConfigs, removeForwardConfig, setForwardConfig } from "../repository/forwards";
import { ALL_BADGES, BADGE_META, BiomeHuntError, formatBiomeName, resolveBiomeSelector } from "../types";
import { updateCounterForGuild } from "../workers/CounterEngine";

export async function showConfig(guildId: string): Promise<EmbedBuilder> {
    const config = await getOrCreateGuildConfig(guildId);
    const roles = await getGuildRoles(guildId);
    const categories = await getEnabledCategories(guildId);
    const badgeRoles = await getGuildBadgeRoles(guildId);
    const forwards = await getForwardConfigs(guildId);
    const autoDeleteEnabled = await isFlagEnabled(guildId, "AUTO_DELETE_ENABLED");

    const badgeRoleMap = new Map(badgeRoles.map((b) => [b.badge, b.role_id]));
    const badgeLines = ALL_BADGES.map((badge) => {
        const roleId = badgeRoleMap.get(badge);
        return `${BADGE_META[badge].emoji} ${BADGE_META[badge].display}: ${roleId ? `<@&${roleId}>` : "not set"}`;
    });

    const forwardLines = forwards.length > 0
        ? forwards.map((f) => `${formatBiomeName(f.biome)} — <#${f.channel_id}>${f.role_id ? ` (pings <@&${f.role_id}>)` : ""}`)
        : ["None configured."];

    return new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("BiomeHunt Configuration")
        .addFields(
            {
                name: "Activity Thresholds",
                value: `Session gap: ${formatTime(config.session_gap_threshold_s)}\nIdle: ${formatTime(config.idle_threshold_s)}\nInactive: ${formatTime(config.inactive_threshold_s)}`,
            },
            { name: "Categories", value: categories.length > 0 ? categories.map((c) => `<#${c.discord_category_id}>`).join(", ") : "None" },
            {
                name: "Roles",
                value: `Active: ${roles.active ? `<@&${roles.active}>` : "not set"}\nIdle: ${roles.idle ? `<@&${roles.idle}>` : "not set"}\nInactive: ${roles.inactive ? `<@&${roles.inactive}>` : "not set"}`,
            },
            { name: "Special Biome Roles", value: badgeLines.join("\n") },
            {
                name: "Biome Forwards",
                value: forwardLines.join("\n"),
            },
            { name: "Auto-create categories", value: config.auto_create_categories ? "Enabled" : "Disabled", inline: true },
            { name: "Auto-delete inactive users", value: autoDeleteEnabled ? `Enabled, ${formatTime(config.delete_inactive_after_s)} after going inactive` : `Disabled (would be ${formatTime(config.delete_inactive_after_s)})`, inline: true },
            { name: "Live counter", value: config.counter_channel_id ? `<#${config.counter_channel_id}>` : "Disabled", inline: true },
        );
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

/** Sets all 3 status roles at once - used by the ez-setup wizard's single-screen role picker. The admin CLI sets them one at a time via `activity set-role`. */
export async function setRolesAction(guildId: string, activeId: string, idleId: string, inactiveId: string): Promise<string> {
    await setGuildRoles(guildId, activeId, idleId, inactiveId);
    return `Roles updated: active <@&${activeId}>, idle <@&${idleId}>, inactive <@&${inactiveId}>.`;
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
        throw new BiomeHuntError("Live counter isn't configured for this server. Set one with `counter set`.");
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

async function setForwardAction(guildId: string, selector: string, channelId: string, roleId: string | null): Promise<string> {
    const biomes = resolveBiomeSelector(selector);
    for (const biome of biomes) await setForwardConfig(guildId, biome, channelId, roleId);

    const roleNote = roleId ? `, pinging <@&${roleId}>` : "";
    if (biomes.length === 1) return `${formatBiomeName(biomes[0])} will now be forwarded to <#${channelId}>${roleNote}.`;
    return `${biomes.length} biomes will now be forwarded to <#${channelId}>${roleNote}: ${biomes.map(formatBiomeName).join(", ")}.`;
}

/**
 * `channel` is optional: omitting it (with no `role` either) removes the forward instead of
 * setting it. Passing `role` without `channel` is rejected - a role ping needs a destination.
 */
export async function forwardSetAction(guildId: string, selector: string, channelId: string | null, roleId: string | null): Promise<string> {
    if (!channelId) {
        if (roleId) throw new BiomeHuntError("Missing required argument: channel");
        return removeForwardAction(guildId, selector);
    }
    return setForwardAction(guildId, selector, channelId, roleId);
}

async function removeForwardAction(guildId: string, selector: string): Promise<string> {
    const biomes = resolveBiomeSelector(selector);
    const removed: string[] = [];
    for (const biome of biomes) {
        if (await removeForwardConfig(guildId, biome)) removed.push(biome);
    }

    if (removed.length === 0) throw new BiomeHuntError("No matching biome forward is configured.");
    if (removed.length === 1) return `Forward for ${formatBiomeName(removed[0])} removed.`;
    return `Removed ${removed.length} biome forward(s): ${removed.map(formatBiomeName).join(", ")}.`;
}

export async function listForwardsAction(guildId: string): Promise<EmbedBuilder> {
    const forwards = await getForwardConfigs(guildId);
    const embed = new EmbedBuilder().setColor(0x5865f2).setTitle("BiomeHunt Biome Forwards");

    if (forwards.length === 0) {
        embed.setDescription("No biome forwards configured yet.");
        return embed;
    }

    const lines = forwards.map((f) => `${formatBiomeName(f.biome)} — <#${f.channel_id}>${f.role_id ? ` (pings <@&${f.role_id}>)` : ""}`);
    embed.setDescription(lines.join("\n"));
    return embed;
}
