import { ChannelType, ComponentType, EmbedBuilder, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import type { Guild, GuildMember, Message } from "discord.js";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import { EmbedFormatter } from "@/utils/format";
import { Logger } from "@/utils/logging";
import { getFailureQuip } from "@/utils/quips";
import {
    addCategoryAction, clearRolesAction, disableCounterAction, removeCategoryAction, resetConfigAction,
    resetQuotaAction, resetThresholdsAction, setAutoCreateCategoriesAction, setCounterChannelAction,
    setQuotaAction, setRolesAction, setThresholdsAction, showConfig, testConfigAction,
} from "./adminConfigActions";
import {
    checkUserAction, guildStatsAction, leaderboardAction, pauseUserAction, removeUserAction,
    resetUserAction, setupUserAction, unpauseUserAction,
} from "./adminUserActions";
import { buildHistoryEmbed, buildHistoryRow, getSessionHistory, SESSIONS_PER_PAGE } from "./profileViews";
import { BiomeHuntError } from "../types";

const logger = new Logger("biomehunt.commands.bh-admin");

export default defineCommand({
    name: "bh-admin",
    description: "Admin commands for biome hunt module.",
    category: CommandCategory.ADMIN,
    showOnHelp: true,
    adminOnly: true,

    options: new SlashCommandBuilder()
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommandGroup((g) =>
            g.setName("config").setDescription("BiomeHunt configuration for this server.")
                .addSubcommand((s) => s.setName("show").setDescription("Show the current BiomeHunt configuration."))
                .addSubcommand((s) =>
                    s.setName("set-thresholds").setDescription("Set activity thresholds.")
                        .addIntegerOption((o) => o.setName("session_gap_minutes").setDescription("Session gap, in minutes").setRequired(true).setMinValue(1))
                        .addIntegerOption((o) => o.setName("idle_minutes").setDescription("Idle threshold, in minutes").setRequired(true).setMinValue(1))
                        .addIntegerOption((o) => o.setName("inactive_hours").setDescription("Inactive threshold, in hours").setRequired(true).setMinValue(1)),
                )
                .addSubcommand((s) => s.setName("reset-thresholds").setDescription("Reset thresholds to defaults."))
                .addSubcommand((s) =>
                    s.setName("set-quota").setDescription("Set the activity quota.")
                        .addIntegerOption((o) => o.setName("window_hours").setDescription("Rolling window size, in hours").setRequired(true).setMinValue(1))
                        .addNumberOption((o) => o.setName("target_hours").setDescription("Required active hours within the window").setRequired(true).setMinValue(0.1)),
                )
                .addSubcommand((s) => s.setName("reset-quota").setDescription("Reset quota to defaults."))
                .addSubcommand((s) =>
                    s.setName("auto-create-categories").setDescription("Toggle automatic category creation.")
                        .addBooleanOption((o) => o.setName("enabled").setDescription("Enable or disable").setRequired(true)),
                )
                .addSubcommand((s) =>
                    s.setName("add-category").setDescription("Allow a category for macro channels.")
                        .addChannelOption((o) => o.setName("category").setDescription("Category channel").setRequired(true).addChannelTypes(ChannelType.GuildCategory)),
                )
                .addSubcommand((s) =>
                    s.setName("remove-category").setDescription("Disallow a category for macro channels.")
                        .addChannelOption((o) => o.setName("category").setDescription("Category channel").setRequired(true).addChannelTypes(ChannelType.GuildCategory)),
                )
                .addSubcommand((s) =>
                    s.setName("set-roles").setDescription("Set the status roles.")
                        .addRoleOption((o) => o.setName("active").setDescription("Active role").setRequired(true))
                        .addRoleOption((o) => o.setName("idle").setDescription("Idle role").setRequired(true))
                        .addRoleOption((o) => o.setName("inactive").setDescription("Inactive role").setRequired(true)),
                )
                .addSubcommand((s) => s.setName("clear-roles").setDescription("Unset all status roles."))
                .addSubcommand((s) =>
                    s.setName("set-counter-channel").setDescription("Set the live counter channel.")
                        .addChannelOption((o) => o.setName("channel").setDescription("Text channel").setRequired(true).addChannelTypes(ChannelType.GuildText)),
                )
                .addSubcommand((s) => s.setName("disable-counter").setDescription("Disable the live counter."))
                .addSubcommand((s) => s.setName("test").setDescription("Check whether required configuration is complete."))
                .addSubcommand((s) => s.setName("reset").setDescription("Reset all BiomeHunt configuration for this server.")),
        )
        .addSubcommandGroup((g) =>
            g.setName("user").setDescription("Manage a specific user's BiomeHunt data.")
                .addSubcommand((s) =>
                    s.setName("check").setDescription("View a user's BiomeHunt profile.")
                        .addUserOption((o) => o.setName("user").setDescription("Target user").setRequired(true)),
                )
                .addSubcommand((s) =>
                    s.setName("reset").setDescription("Wipe a user's data and allow a new setup.")
                        .addUserOption((o) => o.setName("user").setDescription("Target user").setRequired(true)),
                )
                .addSubcommand((s) =>
                    s.setName("remove").setDescription("Remove a user from BiomeHunt.")
                        .addUserOption((o) => o.setName("user").setDescription("Target user").setRequired(true)),
                )
                .addSubcommand((s) =>
                    s.setName("pause").setDescription("Exempt a user from inactivity auto-delete.")
                        .addUserOption((o) => o.setName("user").setDescription("Target user").setRequired(true)),
                )
                .addSubcommand((s) =>
                    s.setName("unpause").setDescription("Re-expose a user to inactivity auto-delete.")
                        .addUserOption((o) => o.setName("user").setDescription("Target user").setRequired(true)),
                )
                .addSubcommand((s) =>
                    s.setName("setup").setDescription("Force-run setup on behalf of a user.")
                        .addUserOption((o) => o.setName("user").setDescription("Target user").setRequired(true)),
                )
                .addSubcommand((s) =>
                    s.setName("session").setDescription("View a user's recent activity sessions.")
                        .addUserOption((o) => o.setName("user").setDescription("Target user").setRequired(true)),
                ),
        )
        .addSubcommand((s) => s.setName("guild-stats").setDescription("Show guild-wide BiomeHunt stats."))
        .addSubcommand((s) => s.setName("leaderboard").setDescription("Show the activity leaderboard.")),

    async executeAsSlash(interaction, _client) {
        if (!interaction.guild) {
            await interaction.reply({ content: "This command only works in a server.", ephemeral: true });
            return;
        }
        const group = interaction.options.getSubcommandGroup(false);
        const sub = interaction.options.getSubcommand(true);
        const routeKey = group ? `${group}-${sub}` : sub;

        if (routeKey === "user-session") {
            const target = interaction.options.getUser("user");
            const member = target && await interaction.guild.members.fetch(target.id).catch(() => null);
            if (!member) {
                await interaction.reply({ content: "Could not resolve that member.", ephemeral: true });
                return;
            }
            await interaction.deferReply();
            await replySessionHistory(interaction.guild.id, member, interaction.user.id, (payload) => interaction.editReply(payload));
            return;
        }

        await interaction.deferReply();
        try {
            const result = await runSubcommand(routeKey, interaction.guild, {
                getInteger: (name) => interaction.options.getInteger(name),
                getNumber: (name) => interaction.options.getNumber(name),
                getBoolean: (name) => interaction.options.getBoolean(name),
                getChannelId: async (name) => interaction.options.getChannel(name)?.id ?? null,
                getRoleId: async (name) => interaction.options.getRole(name)?.id ?? null,
                getUserId: async (name) => interaction.options.getUser(name)?.id ?? null,
                getMember: async (name) => {
                    const user = interaction.options.getUser(name);
                    if (!user) return null;
                    return interaction.guild!.members.fetch(user.id).catch(() => null);
                },
            });
            await interaction.editReply(toReplyPayload(result));
        } catch (err) {
            await interaction.editReply({ embeds: [EmbedFormatter.error(errorMessage(err))] });
        }
    },

    async executeAsPrefix(message, args, _client) {
        if (!message.guild) {
            await message.reply("This command only works in a server.");
            return;
        }
        const group = args.getSubcommandGroup();
        const sub = args.getSubcommand();
        if (!sub) {
            await message.reply({ embeds: [EmbedFormatter.info("Run `bh-admin config show` to see the current configuration.")] });
            return;
        }
        const routeKey = group ? `${group}-${sub}` : sub;

        if (routeKey === "user-session") {
            const member = await args.getMember("user");
            if (!member) {
                await message.reply("Could not resolve that member. Try pinging them instead.");
                return;
            }
            await replySessionHistory(message.guild.id, member, message.author.id, (payload) => message.reply(payload));
            return;
        }

        try {
            const result = await runSubcommand(routeKey, message.guild, {
                getInteger: (name) => args.getNumber(name),
                getNumber: (name) => args.getNumber(name),
                getBoolean: (name) => args.getBoolean(name),
                getChannelId: async (name) => (await args.getChannel(name))?.id ?? null,
                getRoleId: async (name) => (await args.getRole(name))?.id ?? null,
                getUserId: async (name) => (await args.getUser(name))?.id ?? null,
                getMember: (name) => args.getMember(name),
            });
            await message.reply(toReplyPayload(result));
        } catch (err) {
            await message.reply({ embeds: [EmbedFormatter.error(errorMessage(err))] });
        }
    },
});

interface ArgReader {
    getInteger(name: string): number | null;
    getNumber(name: string): number | null;
    getBoolean(name: string): boolean | null;
    getChannelId(name: string): Promise<string | null>;
    getRoleId(name: string): Promise<string | null>;
    getUserId(name: string): Promise<string | null>;
    getMember(name: string): Promise<GuildMember | null>;
}

function requireNumber(value: number | null, name: string): number {
    if (value === null) throw new BiomeHuntError(`Missing required argument: ${name}`);
    return value;
}

async function runSubcommand(sub: string, guild: Guild, args: ArgReader): Promise<string | EmbedBuilder> {
    const guildId = guild.id;

    switch (sub) {
        case "config-show":
            return showConfig(guildId);
        case "config-set-thresholds":
            return setThresholdsAction(
                guildId,
                requireNumber(args.getInteger("session_gap_minutes"), "session_gap_minutes"),
                requireNumber(args.getInteger("idle_minutes"), "idle_minutes"),
                requireNumber(args.getInteger("inactive_hours"), "inactive_hours"),
            );
        case "config-reset-thresholds":
            return resetThresholdsAction(guildId);
        case "config-set-quota":
            return setQuotaAction(
                guildId,
                requireNumber(args.getInteger("window_hours"), "window_hours"),
                requireNumber(args.getNumber("target_hours"), "target_hours"),
            );
        case "config-reset-quota":
            return resetQuotaAction(guildId);
        case "config-auto-create-categories": {
            const enabled = args.getBoolean("enabled");
            if (enabled === null) throw new BiomeHuntError("Missing required argument: enabled");
            return setAutoCreateCategoriesAction(guildId, enabled);
        }
        case "config-add-category": {
            const id = await args.getChannelId("category");
            if (!id) throw new BiomeHuntError("Missing required argument: category");
            return addCategoryAction(guildId, id);
        }
        case "config-remove-category": {
            const id = await args.getChannelId("category");
            if (!id) throw new BiomeHuntError("Missing required argument: category");
            return removeCategoryAction(guildId, id);
        }
        case "config-set-roles": {
            const active = await args.getRoleId("active");
            const idle = await args.getRoleId("idle");
            const inactive = await args.getRoleId("inactive");
            if (!active || !idle || !inactive) throw new BiomeHuntError("All three roles (active, idle, inactive) are required.");
            return setRolesAction(guildId, active, idle, inactive);
        }
        case "config-clear-roles":
            return clearRolesAction(guildId);
        case "config-set-counter-channel": {
            const id = await args.getChannelId("channel");
            if (!id) throw new BiomeHuntError("Missing required argument: channel");
            return setCounterChannelAction(guildId, id);
        }
        case "config-disable-counter":
            return disableCounterAction(guildId);
        case "config-test":
            return testConfigAction(guildId);
        case "config-reset":
            return resetConfigAction(guildId);
        case "user-check": {
            const member = await args.getMember("user");
            if (!member) throw new BiomeHuntError("Missing required argument: user");
            return checkUserAction(guildId, member);
        }
        case "user-reset": {
            const id = await args.getUserId("user");
            if (!id) throw new BiomeHuntError("Missing required argument: user");
            return resetUserAction(guildId, id);
        }
        case "user-remove": {
            const id = await args.getUserId("user");
            if (!id) throw new BiomeHuntError("Missing required argument: user");
            return removeUserAction(guildId, id);
        }
        case "user-pause": {
            const id = await args.getUserId("user");
            if (!id) throw new BiomeHuntError("Missing required argument: user");
            return pauseUserAction(guildId, id);
        }
        case "user-unpause": {
            const id = await args.getUserId("user");
            if (!id) throw new BiomeHuntError("Missing required argument: user");
            return unpauseUserAction(guildId, id);
        }
        case "user-setup": {
            const member = await args.getMember("user");
            if (!member) throw new BiomeHuntError("Could not resolve that member.");
            return setupUserAction(guild, member);
        }
        case "guild-stats":
            return guildStatsAction(guildId);
        case "leaderboard":
            return leaderboardAction(guildId);
        default:
            throw new BiomeHuntError(`Unknown subcommand: ${sub}`);
    }
}

async function replySessionHistory(
    guildId: string,
    member: GuildMember,
    invokerId: string,
    respond: (payload: { embeds: EmbedBuilder[]; components: ReturnType<typeof buildHistoryRow>[] }) => Promise<Message>,
): Promise<void> {
    const sessions = await getSessionHistory(guildId, member.id);
    if (sessions === null) {
        await respond({ embeds: [EmbedFormatter.info(`<@${member.id}> doesn't have a profile yet.`)], components: [] });
        return;
    }
    if (sessions.length === 0) {
        await respond({ embeds: [EmbedFormatter.info(`<@${member.id}> has no activity recorded yet.`)], components: [] });
        return;
    }

    const pages = Math.max(Math.ceil(sessions.length / SESSIONS_PER_PAGE), 1);
    let page = 0;
    const msg = await respond({
        embeds: [buildHistoryEmbed(sessions, member, page)],
        components: pages > 1 ? [buildHistoryRow(page, pages)] : [],
    });

    if (pages <= 1) return;

    const collector = msg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 60_000 });

    collector.on("collect", async (i) => {
        if (i.user.id !== invokerId) {
            await i.reply({ content: "These buttons aren't yours!", ephemeral: true });
            return;
        }
        if (i.customId === "history-prev" && page > 0) page--;
        if (i.customId === "history-next" && page < pages - 1) page++;
        await i.update({
            embeds: [buildHistoryEmbed(sessions, member, page)],
            components: [buildHistoryRow(page, pages)],
        });
    });

    collector.on("end", async () => {
        await msg.edit({ components: [] }).catch(() => { });
    });
}

function toReplyPayload(result: string | EmbedBuilder): { embeds: EmbedBuilder[] } {
    const embed = typeof result === "string" ? EmbedFormatter.success(result) : result;
    return { embeds: [embed] };
}

function errorMessage(err: unknown): string {
    if (err instanceof BiomeHuntError) return err.message;
    logger.error(err instanceof Error ? err : new Error(String(err)));
    return getFailureQuip();
}
