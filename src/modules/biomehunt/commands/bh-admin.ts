import { ChannelType, ComponentType, EmbedBuilder, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import type { Guild, GuildMember, Message } from "discord.js";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import { EmbedFormatter } from "@/utils/format";
import { Logger } from "@/utils/logging";
import { getFailureQuip } from "@/utils/quips";
import {
    addCategoryAction, clearBadgeRolesAction, clearRolesAction, disableAutoDeleteAction, disableCounterAction,
    forceCounterUpdateAction, forceQuotaEvalAction, listQuotaRolesAction, removeCategoryAction, removeQuotaRoleAction,
    resetConfigAction, resetThresholdsAction, setAutoCreateCategoriesAction, setAutoDeleteAction, setBadgeRoleAction,
    setCounterChannelAction, setQuotaEvalHourAction, setQuotaRoleAction, setRolesAction, setThresholdsAction,
    showConfig, testConfigAction,
} from "./adminConfigActions";
import {
    addBadgeAction, checkUserAction, guildStatsAction, leaderboardAction, pauseUserAction, quotaProgressAction,
    removeBadgeAction, removeUserAction, resetUserAction, setupUserAction, unpauseUserAction,
} from "./adminUserActions";
import { runEzSetup } from "./ezsetup";
import {
    buildHistoryEmbed, buildHistoryRow, buildUserListEmbed, buildUserListRow, getSessionHistory,
    getUserListPage, SESSIONS_PER_PAGE, USERS_PER_PAGE,
} from "./profileViews";
import { BiomeHuntError, type ActivityStatus, type Badge, type QuotaRoleMode } from "../types";

const logger = new Logger("biomehunt.commands.bh-admin");

export default defineCommand({
    name: "bh-admin",
    description: "Admin commands for biome hunt module.",
    category: CommandCategory.ADMIN,
    showOnHelp: true,
    adminOnly: true,

    options: new SlashCommandBuilder()
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand((s) => s.setName("show").setDescription("Show the current BiomeHunt configuration."))
        .addSubcommand((s) => s.setName("test").setDescription("Check whether required configuration is complete."))
        .addSubcommand((s) => s.setName("reset-all").setDescription("Reset all BiomeHunt configuration for this server."))
        .addSubcommand((s) => s.setName("ezsetup").setDescription("Guided step-by-step setup wizard."))
        .addSubcommand((s) => s.setName("force-quota-eval").setDescription("Immediately run the Fixed-mode quota reward evaluation for this server."))
        .addSubcommandGroup((g) =>
            g.setName("thresholds").setDescription("Activity thresholds.")
                .addSubcommand((s) =>
                    s.setName("set").setDescription("Set activity thresholds.")
                        .addIntegerOption((o) => o.setName("session_gap_minutes").setDescription("Session gap, in minutes").setRequired(true).setMinValue(1))
                        .addIntegerOption((o) => o.setName("idle_minutes").setDescription("Idle threshold, in minutes").setRequired(true).setMinValue(1))
                        .addIntegerOption((o) => o.setName("inactive_hours").setDescription("Inactive threshold, in hours").setRequired(true).setMinValue(1)),
                )
                .addSubcommand((s) => s.setName("reset").setDescription("Reset thresholds to defaults."))
                .addSubcommand((s) =>
                    s.setName("set-auto-delete").setDescription("Auto-delete a user's macro channel after prolonged inactivity.")
                        .addNumberOption((o) => o.setName("hours").setDescription("Hours after going inactive").setRequired(true).setMinValue(0.1)),
                )
                .addSubcommand((s) => s.setName("disable-auto-delete").setDescription("Disable auto-deleting inactive users' channels.")),
        )
        .addSubcommandGroup((g) =>
            g.setName("categories").setDescription("Macro channel categories.")
                .addSubcommand((s) =>
                    s.setName("add").setDescription("Allow a category for macro channels.")
                        .addChannelOption((o) => o.setName("category").setDescription("Category channel").setRequired(true).addChannelTypes(ChannelType.GuildCategory)),
                )
                .addSubcommand((s) =>
                    s.setName("remove").setDescription("Disallow a category for macro channels.")
                        .addChannelOption((o) => o.setName("category").setDescription("Category channel").setRequired(true).addChannelTypes(ChannelType.GuildCategory)),
                )
                .addSubcommand((s) =>
                    s.setName("auto-create").setDescription("Toggle automatic category creation.")
                        .addBooleanOption((o) => o.setName("enabled").setDescription("Enable or disable").setRequired(true)),
                ),
        )
        .addSubcommandGroup((g) =>
            g.setName("roles").setDescription("Status roles (active/idle/inactive).")
                .addSubcommand((s) =>
                    s.setName("set").setDescription("Set the status roles.")
                        .addRoleOption((o) => o.setName("active").setDescription("Active role").setRequired(true))
                        .addRoleOption((o) => o.setName("idle").setDescription("Idle role").setRequired(true))
                        .addRoleOption((o) => o.setName("inactive").setDescription("Inactive role").setRequired(true)),
                )
                .addSubcommand((s) => s.setName("clear").setDescription("Unset all status roles."))
                .addSubcommand((s) =>
                    s.setName("found-glitched").setDescription("Set the role awarded for finding the Glitched biome.")
                        .addRoleOption((o) => o.setName("role").setDescription("Reward role").setRequired(true)),
                )
                .addSubcommand((s) =>
                    s.setName("found-cyberspace").setDescription("Set the role awarded for finding the Cyberspace biome.")
                        .addRoleOption((o) => o.setName("role").setDescription("Reward role").setRequired(true)),
                )
                .addSubcommand((s) =>
                    s.setName("found-dreamspace").setDescription("Set the role awarded for finding the Dreamspace biome.")
                        .addRoleOption((o) => o.setName("role").setDescription("Reward role").setRequired(true)),
                )
                .addSubcommand((s) => s.setName("clear-badges").setDescription("Unset all special biome badge roles.")),
        )
        .addSubcommandGroup((g) =>
            g.setName("counter").setDescription("Live activity counter.")
                .addSubcommand((s) =>
                    s.setName("set-channel").setDescription("Set the live counter channel.")
                        .addChannelOption((o) => o.setName("channel").setDescription("Text channel").setRequired(true).addChannelTypes(ChannelType.GuildText)),
                )
                .addSubcommand((s) => s.setName("disable").setDescription("Disable the live counter."))
                .addSubcommand((s) => s.setName("force-update").setDescription("Immediately refresh the live activity counter.")),
        )
        .addSubcommandGroup((g) =>
            g.setName("quota-roles").setDescription("Quota reward roles.")
                .addSubcommand((s) =>
                    s.setName("set").setDescription("Set (or update) a quota reward role.")
                        .addRoleOption((o) => o.setName("role").setDescription("Reward role").setRequired(true))
                        .addStringOption((o) =>
                            o.setName("mode").setDescription("Evaluation mode").setRequired(true)
                                .addChoices({ name: "Fixed (daily check, timed access)", value: "F" }, { name: "Rolling Window (continuous)", value: "RW" }),
                        )
                        .addNumberOption((o) => o.setName("quota_hours").setDescription("Required active hours within the window").setRequired(true).setMinValue(0.1))
                        .addIntegerOption((o) => o.setName("quota_window_hours").setDescription("Rolling window size, in hours").setRequired(true).setMinValue(1))
                        .addIntegerOption((o) => o.setName("access_duration_days").setDescription("Access duration in days (Fixed mode only)").setMinValue(1)),
                )
                .addSubcommand((s) =>
                    s.setName("remove").setDescription("Remove a configured quota reward role.")
                        .addRoleOption((o) => o.setName("role").setDescription("Reward role").setRequired(true)),
                )
                .addSubcommand((s) => s.setName("list").setDescription("List all configured quota reward roles."))
                .addSubcommand((s) =>
                    s.setName("eval-hour").setDescription("Set the UTC hour Fixed-mode rewards are evaluated at.")
                        .addIntegerOption((o) => o.setName("hour").setDescription("UTC hour (0-23)").setRequired(true).setMinValue(0).setMaxValue(23)),
                ),
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
                )
                .addSubcommand((s) =>
                    s.setName("quota-progress").setDescription("View a user's progress toward configured quota rewards.")
                        .addUserOption((o) => o.setName("user").setDescription("Target user").setRequired(true)),
                )
                .addSubcommand((s) =>
                    s.setName("add-badge").setDescription("Manually grant a special biome badge to a user.")
                        .addUserOption((o) => o.setName("user").setDescription("Target user").setRequired(true))
                        .addStringOption((o) =>
                            o.setName("badge").setDescription("Badge").setRequired(true)
                                .addChoices(
                                    { name: "Glitched", value: "GLITCHED" },
                                    { name: "Cyberspace", value: "CYBERSPACE" },
                                    { name: "Dreamspace", value: "DREAMSPACE" },
                                ),
                        ),
                )
                .addSubcommand((s) =>
                    s.setName("remove-badge").setDescription("Manually remove a special biome badge from a user.")
                        .addUserOption((o) => o.setName("user").setDescription("Target user").setRequired(true))
                        .addStringOption((o) =>
                            o.setName("badge").setDescription("Badge").setRequired(true)
                                .addChoices(
                                    { name: "Glitched", value: "GLITCHED" },
                                    { name: "Cyberspace", value: "CYBERSPACE" },
                                    { name: "Dreamspace", value: "DREAMSPACE" },
                                ),
                        ),
                ),
        )
        .addSubcommand((s) => s.setName("guild-stats").setDescription("Show guild-wide BiomeHunt stats."))
        .addSubcommand((s) => s.setName("leaderboard").setDescription("Show the activity leaderboard."))
        .addSubcommand((s) =>
            s.setName("list-users").setDescription("List users, optionally filtered by status.")
                .addStringOption((o) =>
                    o.setName("status").setDescription("Filter by status")
                        .addChoices({ name: "Active", value: "active" }, { name: "Idle", value: "idle" }, { name: "Inactive", value: "inactive" }),
                ),
        ),

    async executeAsSlash(interaction, client) {
        if (!interaction.guild) {
            await interaction.reply({ content: "This command only works in a server.", ephemeral: true });
            return;
        }
        const group = interaction.options.getSubcommandGroup(false);
        const sub = interaction.options.getSubcommand(true);
        const routeKey = group ? `${group}-${sub}` : sub;

        if (routeKey === "counter-force-update") {
            await interaction.deferReply();
            try {
                const result = await forceCounterUpdateAction(client, interaction.guild.id);
                await interaction.editReply(toReplyPayload(result));
            } catch (err) {
                await interaction.editReply({ embeds: [EmbedFormatter.error(errorMessage(err))] });
            }
            return;
        }

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

        if (routeKey === "ezsetup") {
            await interaction.deferReply();
            await runEzSetup(interaction.guild, interaction.user.id, (payload) => interaction.editReply(payload));
            return;
        }

        if (routeKey === "list-users") {
            const status = interaction.options.getString("status") as ActivityStatus | null;
            await interaction.deferReply();
            await replyUserList(interaction.guild.id, status, interaction.user.id, (payload) => interaction.editReply(payload));
            return;
        }

        await interaction.deferReply();
        try {
            const result = await runSubcommand(routeKey, interaction.guild, {
                getString: (name) => interaction.options.getString(name),
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

    async executeAsPrefix(message, args, client) {
        if (!message.guild) {
            await message.reply("This command only works in a server.");
            return;
        }
        const group = args.getSubcommandGroup();
        const sub = args.getSubcommand();
        if (!sub) {
            await message.reply({ embeds: [EmbedFormatter.info("Run `bh-admin show` to see the current configuration.")] });
            return;
        }
        const routeKey = group ? `${group}-${sub}` : sub;

        if (routeKey === "counter-force-update") {
            try {
                const result = await forceCounterUpdateAction(client, message.guild.id);
                await message.reply(toReplyPayload(result));
            } catch (err) {
                await message.reply({ embeds: [EmbedFormatter.error(errorMessage(err))] });
            }
            return;
        }

        if (routeKey === "user-session") {
            const member = await args.getMember("user");
            if (!member) {
                await message.reply("Could not resolve that member. Try pinging them instead.");
                return;
            }
            await replySessionHistory(message.guild.id, member, message.author.id, (payload) => message.reply(payload));
            return;
        }

        if (routeKey === "ezsetup") {
            await runEzSetup(message.guild, message.author.id, (payload) => message.reply(payload));
            return;
        }

        if (routeKey === "list-users") {
            const status = args.getString("status")?.toLowerCase() as ActivityStatus | null;
            await replyUserList(message.guild.id, status ?? null, message.author.id, (payload) => message.reply(payload));
            return;
        }

        try {
            const result = await runSubcommand(routeKey, message.guild, {
                getString: (name) => args.getString(name),
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
    getString(name: string): string | null;
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
        case "show":
            return showConfig(guildId);
        case "test":
            return testConfigAction(guildId);
        case "reset-all":
            return resetConfigAction(guildId);
        case "force-quota-eval":
            return forceQuotaEvalAction(guildId);
        case "thresholds-set":
            return setThresholdsAction(
                guildId,
                requireNumber(args.getInteger("session_gap_minutes"), "session_gap_minutes"),
                requireNumber(args.getInteger("idle_minutes"), "idle_minutes"),
                requireNumber(args.getInteger("inactive_hours"), "inactive_hours"),
            );
        case "thresholds-reset":
            return resetThresholdsAction(guildId);
        case "thresholds-set-auto-delete": {
            const hours = args.getNumber("hours");
            if (hours === null) throw new BiomeHuntError("Missing required argument: hours");
            return setAutoDeleteAction(guildId, hours);
        }
        case "thresholds-disable-auto-delete":
            return disableAutoDeleteAction(guildId);
        case "categories-auto-create": {
            const enabled = args.getBoolean("enabled");
            if (enabled === null) throw new BiomeHuntError("Missing required argument: enabled");
            return setAutoCreateCategoriesAction(guildId, enabled);
        }
        case "categories-add": {
            const id = await args.getChannelId("category");
            if (!id) throw new BiomeHuntError("Missing required argument: category");
            return addCategoryAction(guildId, id);
        }
        case "categories-remove": {
            const id = await args.getChannelId("category");
            if (!id) throw new BiomeHuntError("Missing required argument: category");
            return removeCategoryAction(guildId, id);
        }
        case "roles-set": {
            const active = await args.getRoleId("active");
            const idle = await args.getRoleId("idle");
            const inactive = await args.getRoleId("inactive");
            if (!active || !idle || !inactive) throw new BiomeHuntError("All three roles (active, idle, inactive) are required.");
            return setRolesAction(guildId, active, idle, inactive);
        }
        case "roles-clear":
            return clearRolesAction(guildId);
        case "roles-found-glitched": {
            const roleId = await args.getRoleId("role");
            if (!roleId) throw new BiomeHuntError("Missing required argument: role");
            return setBadgeRoleAction(guildId, "GLITCHED", roleId);
        }
        case "roles-found-cyberspace": {
            const roleId = await args.getRoleId("role");
            if (!roleId) throw new BiomeHuntError("Missing required argument: role");
            return setBadgeRoleAction(guildId, "CYBERSPACE", roleId);
        }
        case "roles-found-dreamspace": {
            const roleId = await args.getRoleId("role");
            if (!roleId) throw new BiomeHuntError("Missing required argument: role");
            return setBadgeRoleAction(guildId, "DREAMSPACE", roleId);
        }
        case "roles-clear-badges":
            return clearBadgeRolesAction(guildId);
        case "counter-set-channel": {
            const id = await args.getChannelId("channel");
            if (!id) throw new BiomeHuntError("Missing required argument: channel");
            return setCounterChannelAction(guildId, id);
        }
        case "counter-disable":
            return disableCounterAction(guildId);
        case "quota-roles-set": {
            const roleId = await args.getRoleId("role");
            const mode = args.getString("mode")?.toUpperCase() as QuotaRoleMode | null;
            const quotaHours = args.getNumber("quota_hours");
            const quotaWindowHours = args.getInteger("quota_window_hours");
            const accessDurationDays = args.getInteger("access_duration_days");
            if (!roleId || !mode) throw new BiomeHuntError("Missing required argument: role or mode.");
            return setQuotaRoleAction(
                guildId,
                roleId,
                mode,
                requireNumber(quotaHours, "quota_hours"),
                requireNumber(quotaWindowHours, "quota_window_hours"),
                accessDurationDays,
            );
        }
        case "quota-roles-remove": {
            const roleId = await args.getRoleId("role");
            if (!roleId) throw new BiomeHuntError("Missing required argument: role");
            return removeQuotaRoleAction(guildId, roleId);
        }
        case "quota-roles-list":
            return listQuotaRolesAction(guildId);
        case "quota-roles-eval-hour": {
            const hour = args.getInteger("hour");
            if (hour === null) throw new BiomeHuntError("Missing required argument: hour");
            return setQuotaEvalHourAction(guildId, hour);
        }
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
        case "user-quota-progress": {
            const id = await args.getUserId("user");
            if (!id) throw new BiomeHuntError("Missing required argument: user");
            return quotaProgressAction(guildId, id);
        }
        case "user-add-badge": {
            const id = await args.getUserId("user");
            const badge = args.getString("badge") as Badge | null;
            if (!id) throw new BiomeHuntError("Missing required argument: user");
            if (!badge) throw new BiomeHuntError("Missing required argument: badge");
            return addBadgeAction(guildId, id, badge);
        }
        case "user-remove-badge": {
            const id = await args.getUserId("user");
            const badge = args.getString("badge") as Badge | null;
            if (!id) throw new BiomeHuntError("Missing required argument: user");
            if (!badge) throw new BiomeHuntError("Missing required argument: badge");
            return removeBadgeAction(guildId, id, badge);
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

async function replyUserList(
    guildId: string,
    status: ActivityStatus | null,
    invokerId: string,
    respond: (payload: { embeds: EmbedBuilder[]; components: ReturnType<typeof buildUserListRow>[] }) => Promise<Message>,
): Promise<void> {
    const users = await getUserListPage(guildId, status);
    const pages = Math.max(Math.ceil(users.length / USERS_PER_PAGE), 1);
    let page = 0;
    const msg = await respond({
        embeds: [buildUserListEmbed(users, page, status)],
        components: pages > 1 ? [buildUserListRow(page, pages)] : [],
    });

    if (pages <= 1) return;

    const collector = msg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 60_000 });

    collector.on("collect", async (i) => {
        if (i.user.id !== invokerId) {
            await i.reply({ content: "These buttons aren't yours!", ephemeral: true });
            return;
        }
        if (i.customId === "userlist-prev" && page > 0) page--;
        if (i.customId === "userlist-next" && page < pages - 1) page++;
        await i.update({
            embeds: [buildUserListEmbed(users, page, status)],
            components: [buildUserListRow(page, pages)],
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
