import { ContainerBuilder, SeparatorSpacingSize } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { formatTime } from "@/utils/format";
import { getBadgeMeta, getBiomeBadges } from "../constants/badges.constants";
import { formatBiomeName } from "../constants/biomes.constants";
import { getGuildBadgeRoles } from "../repository/badges.repository";
import { isFlagEnabled } from "../repository/flags.repository";
import { getForwardConfigs } from "../repository/forwards.repository";
import {
    clearCounterChannel,
    getEnabledCategories,
    getGuildRoles,
    getOrCreateGuildConfig,
    insertCategory,
    setAutoDeleteHours,
    setGuildRoles,
    updateCounterChannel,
    updateThresholds,
} from "../repository/guilds.repository";
import { BiomeHuntError } from "../types";
import { updateCounterForGuild } from "../workers/counter.worker";

function addDivider(container: ContainerBuilder): void {
    container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
}

export async function showConfig(guildId: string): Promise<ContainerBuilder> {
    const config = await getOrCreateGuildConfig(guildId);
    const roles = await getGuildRoles(guildId);
    const categories = await getEnabledCategories(guildId);
    const badgeRoles = await getGuildBadgeRoles(guildId);
    const forwards = await getForwardConfigs(guildId);
    const autoDeleteEnabled = await isFlagEnabled(guildId, "AUTO_DELETE_ENABLED");

    const badgeRoleMap = new Map(badgeRoles.map((b) => [b.badge, b.role_id]));
    const badgeLines = getBiomeBadges().map((badge) => {
        const roleId = badgeRoleMap.get(badge);
        const meta = getBadgeMeta(badge);
        return `${meta.emoji} ${meta.display}: ${roleId ? `<@&${roleId}>` : "not set"}`;
    });

    const forwardLines =
        forwards.length > 0
            ? forwards.map((f) => `${formatBiomeName(f.biome)} - <#${f.channel_id}>${f.role_id ? ` (pings <@&${f.role_id}>)` : ""}`)
            : ["None configured."];

    const container = new ContainerBuilder().setAccentColor(0x5865f2);
    container.addTextDisplayComponents((td) => td.setContent("**Configuration**"));

    addDivider(container);
    container.addTextDisplayComponents((td) =>
        td.setContent(
            `**Activity Thresholds**\nSession gap: ${formatTime(config.session_gap_threshold_s)}\nIdle: ${formatTime(config.idle_threshold_s)}\nInactive: ${formatTime(config.inactive_threshold_s)}`,
        ),
    );

    addDivider(container);
    container.addTextDisplayComponents((td) =>
        td.setContent(
            `**Categories**\n${categories.length > 0 ? categories.map((c) => `<#${c.discord_category_id}>`).join(", ") : "None"}`,
        ),
    );

    addDivider(container);
    container.addTextDisplayComponents((td) =>
        td.setContent(
            `**Roles**\nActive: ${roles.active ? `<@&${roles.active}>` : "not set"}\nIdle: ${roles.idle ? `<@&${roles.idle}>` : "not set"}\nInactive: ${roles.inactive ? `<@&${roles.inactive}>` : "not set"}`,
        ),
    );

    addDivider(container);
    container.addTextDisplayComponents((td) => td.setContent(`**Special Biome Roles**\n${badgeLines.join("\n")}`));

    addDivider(container);
    container.addTextDisplayComponents((td) => td.setContent(`**Biome Forwards**\n${forwardLines.join("\n")}`));

    addDivider(container);
    container.addTextDisplayComponents((td) =>
        td.setContent(
            [
                `- **Auto-create categories:** ${config.auto_create_categories ? "Enabled" : "Disabled"}`,
                `- **Auto-delete inactive users:** ${autoDeleteEnabled ? `Enabled, ${formatTime(config.delete_inactive_after_s)} after going inactive` : `Disabled (would be ${formatTime(config.delete_inactive_after_s)})`}`,
                `- **Live counter:** ${config.counter_channel_id ? `<#${config.counter_channel_id}>` : "Disabled"}`,
            ].join("\n"),
        ),
    );

    return container;
}

export async function addCategory(guildId: string, categoryId: string): Promise<string> {
    await insertCategory(guildId, categoryId);
    return `Category <#${categoryId}> is now allowed for macro channels.`;
}

/** Sets all 3 status roles at once - used by the ez-setup wizard's single-screen role picker. */
export async function setRoles(
    guildId: string,
    activeId: string | null,
    idleId: string | null,
    inactiveId: string | null,
): Promise<string> {
    await setGuildRoles(guildId, activeId, idleId, inactiveId);
    const show = (id: string | null) => (id ? `<@&${id}>` : "none");
    return `Roles updated: active ${show(activeId)}, idle ${show(idleId)}, inactive ${show(inactiveId)}.`;
}

export async function setCounterChannel(guildId: string, channelId: string): Promise<string> {
    await updateCounterChannel(guildId, channelId);
    return `Live counter will now be posted in <#${channelId}>.`;
}

export async function disableCounter(guildId: string): Promise<string> {
    await clearCounterChannel(guildId);
    return "Live counter disabled.";
}

export async function forceCounterUpdate(client: BotClient, guildId: string): Promise<string> {
    const guildConfig = await getOrCreateGuildConfig(guildId);
    if (!guildConfig.counter_channel_id) {
        throw new BiomeHuntError("Live counter isn't configured for this server. Set one in `/admin settings`.");
    }
    await updateCounterForGuild(client, guildConfig);
    return `Live counter updated in <#${guildConfig.counter_channel_id}>.`;
}

export async function setActivityThresholds(
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

/** Sets the auto-delete hours-after-inactive threshold. This alone doesn't enable auto-delete - see the AUTO_DELETE_ENABLED flag. */
export async function setAutoDeleteThreshold(guildId: string, hoursAfterInactive: number): Promise<string> {
    if (hoursAfterInactive <= 0) throw new BiomeHuntError("Hours must be greater than zero.");
    await setAutoDeleteHours(guildId, Math.round(hoursAfterInactive * 3600));
    return (
        `Auto-delete threshold set: a user's macro channel is removed ${hoursAfterInactive}h after they go inactive. ` +
        "Remember this only takes effect while the AUTO_DELETE_ENABLED flag is on (`/admin flags`)."
    );
}
