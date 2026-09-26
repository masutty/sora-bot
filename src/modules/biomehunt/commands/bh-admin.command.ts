import type { Guild, GuildMember, Message } from "discord.js";
import { ChannelType, ContainerBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import type { ConfirmPayload } from "@/utils/confirm";
import { EmbedFormatter, type FormattedReply, NO_PINGS } from "@/utils/format";
import { Logger } from "@/utils/logging";
import { attachPagination, buildPaginationRow } from "@/utils/pagination";
import { getFailureQuip } from "@/utils/quips";
import { ALL_BADGES, BADGE_META, resolveBadgeSlug } from "../constants/badges.constants";
import { BIOME_ONLY_CHOICES, BIOME_SELECTOR_CHOICES } from "../constants/biomes.constants";
import { ALL_FLAGS, FLAG_DEFINITIONS } from "../constants/flags.constants";
import { runEzSetupFlow } from "../flows/ez-setup.flow";
import { runForwardConfigFlow } from "../flows/forward-config.flow";
import {
    deleteActivity, resetActivity, setActivity, setActivityRole,
} from "../services/activity.service";
import { clearActivitySessions, deleteActivitySession } from "../services/activity-session.service";
import { awardBadge, listBadges, setBadges, takeBadge } from "../services/badge.service";
import { grantEconomy } from "../services/economy.service";
import { listFlags, setFlag } from "../services/flag.service";
import { listForwards, setForward } from "../services/forward.service";
import {
    addCategory, 
    disableCounter, forceCounterUpdate,
    removeCategory, resetConfig, setAutoCreateCategories, setCounterChannel,showConfig, testConfig,
} from "../services/guild-config.service";
import {type AdoptParams,
    clearMemberBiomes, decrementMemberBiome, forceSetupMember, hardDeleteMember,pauseMember, 
    resetMemberChannel, softDeleteMember, unpauseMember, 
} from "../services/member.service";
import {
    createQuota, deleteQuotas,forceQuotaEval, listQuotas, setQuotaEvalHour, 
} from "../services/quota.service";
import { type ActivityStatus, type Badge, BiomeHuntError, type FlagName, type QuotaRoleMode } from "../types";
import { buildHistoryContainer, getSessionHistory, runProfileView, SESSIONS_PER_PAGE } from "../views/stats.view";

const logger = new Logger("biomehunt.commands.bh-admin");

const FLAG_CHOICES = ALL_FLAGS.map((name) => ({ name: FLAG_DEFINITIONS[name].label, value: name }));
/** All 4 badges - valid targets for manual award/take. Value is the badge's slug (easy to type in prefix mode), resolved back via `resolveBadgeSlug`. */
const BADGE_CHOICES = (Object.keys(BADGE_META) as Badge[]).map((b) => ({ name: BADGE_META[b].display, value: BADGE_META[b].slug }));
/** Only the role-configurable biome badges - valid targets for `badges set`. */
const CONFIGURABLE_BADGE_CHOICES = ALL_BADGES.map((b) => ({ name: BADGE_META[b].display, value: BADGE_META[b].slug }));
const STATUS_CHOICES = [
    { name: "Active", value: "active" },
    { name: "Idle", value: "idle" },
    { name: "Inactive", value: "inactive" },
];

function requireBadge(slug: string | null): Badge {
    if (!slug) throw new BiomeHuntError("Missing required argument: badge");
    const badge = resolveBadgeSlug(slug);
    if (!badge) throw new BiomeHuntError(`Unknown badge: ${slug}`);
    return badge;
}

export default defineCommand({
    name: "bh-admin",
    description: "Admin commands for biome hunt module.",
    category: CommandCategory.ADMIN,
    showOnHelp: true,
    adminOnly: true,

    options: new SlashCommandBuilder()
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand((s) => s.setName("setup").setDescription("Guided step-by-step setup wizard."))
        .addSubcommand((s) =>
            s.setName("profile").setDescription("View a user's BiomeHunt profile.")
                .addUserOption((o) => o.setName("user").setDescription("Target user").setRequired(true)),
        )
        .addSubcommandGroup((g) =>
            g.setName("config").setDescription("Overall BiomeHunt configuration.")
                .addSubcommand((s) => s.setName("show").setDescription("Show the current BiomeHunt configuration."))
                .addSubcommand((s) => s.setName("test").setDescription("Check whether required configuration is complete."))
                .addSubcommand((s) => s.setName("reset").setDescription("Reset all BiomeHunt configuration for this server.")),
        )
        .addSubcommandGroup((g) =>
            g.setName("activity").setDescription("Activity thresholds, auto-delete, and status roles.")
                .addSubcommand((s) =>
                    s.setName("set").setDescription("Set activity thresholds.")
                        .addIntegerOption((o) => o.setName("session_gap_minutes").setDescription("Session gap, in minutes").setRequired(true).setMinValue(1))
                        .addIntegerOption((o) => o.setName("idle_minutes").setDescription("Idle threshold, in minutes").setRequired(true).setMinValue(1))
                        .addIntegerOption((o) => o.setName("inactive_hours").setDescription("Inactive threshold, in hours").setRequired(true).setMinValue(1)),
                )
                .addSubcommand((s) => s.setName("reset").setDescription("Reset thresholds to defaults."))
                .addSubcommand((s) =>
                    s.setName("delete").setDescription("Set the auto-delete hours-after-inactive threshold. Requires the AUTO_DELETE_ENABLED flag to be on.")
                        .addNumberOption((o) => o.setName("hours").setDescription("Hours after going inactive").setRequired(true).setMinValue(0.1)),
                )
                .addSubcommand((s) =>
                    s.setName("set-role").setDescription("Set (or unset) one status role at a time.")
                        .addStringOption((o) => o.setName("type").setDescription("Status").setRequired(true).addChoices(...STATUS_CHOICES))
                        .addRoleOption((o) => o.setName("role").setDescription("Role (leave empty to unset)")),
                ),
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
            g.setName("badges").setDescription("Manage badges (biome-discovery and bot-triggered).")
                .addSubcommand((s) =>
                    s.setName("award").setDescription("Manually grant a badge to a user.")
                        .addUserOption((o) => o.setName("user").setDescription("Target user").setRequired(true))
                        .addStringOption((o) => o.setName("badge").setDescription("Badge").setRequired(true).addChoices(...BADGE_CHOICES)),
                )
                .addSubcommand((s) =>
                    s.setName("take").setDescription("Manually revoke a badge from a user.")
                        .addUserOption((o) => o.setName("user").setDescription("Target user").setRequired(true))
                        .addStringOption((o) => o.setName("badge").setDescription("Badge").setRequired(true).addChoices(...BADGE_CHOICES)),
                )
                .addSubcommand((s) =>
                    s.setName("set").setDescription("Configure the role a badge grants. Leave role empty to unconfigure it.")
                        .addStringOption((o) => o.setName("badge").setDescription("Badge").setRequired(true).addChoices(...CONFIGURABLE_BADGE_CHOICES))
                        .addRoleOption((o) => o.setName("role").setDescription("Role to grant (leave empty to unconfigure)")),
                )
                .addSubcommand((s) => s.setName("list").setDescription("List all badges and their current role configuration.")),
        )
        .addSubcommandGroup((g) =>
            g.setName("flag").setDescription("Toggle optional BiomeHunt behaviors.")
                .addSubcommand((s) =>
                    s.setName("set").setDescription("Enable or disable a flag.")
                        .addStringOption((o) => o.setName("flag").setDescription("Flag").setRequired(true).addChoices(...FLAG_CHOICES))
                        .addBooleanOption((o) => o.setName("enabled").setDescription("Enable or disable").setRequired(true)),
                )
                .addSubcommand((s) => s.setName("list").setDescription("List all flags, their description, default, and current value.")),
        )
        .addSubcommandGroup((g) =>
            g.setName("economy").setDescription("Manual Seeds/XP balance adjustments.")
                .addSubcommand((s) =>
                    s.setName("grant").setDescription("Grant (or take, with a negative number) Seeds/XP.")
                        .addUserOption((o) => o.setName("user").setDescription("Target user").setRequired(true))
                        .addIntegerOption((o) => o.setName("seeds").setDescription("Seeds delta (negative to take away)"))
                        .addIntegerOption((o) => o.setName("xp").setDescription("XP delta (negative to take away)")),
                ),
        )
        .addSubcommandGroup((g) =>
            g.setName("counter").setDescription("Live activity counter.")
                .addSubcommand((s) =>
                    s.setName("set").setDescription("Set the live counter channel.")
                        .addChannelOption((o) => o.setName("channel").setDescription("Text channel").setRequired(true).addChannelTypes(ChannelType.GuildText)),
                )
                .addSubcommand((s) => s.setName("disable").setDescription("Disable the live counter."))
                .addSubcommand((s) => s.setName("force-update").setDescription("Immediately refresh the live activity counter.")),
        )
        .addSubcommandGroup((g) =>
            g.setName("quotas").setDescription("Quota reward roles.")
                .addSubcommand((s) =>
                    s.setName("create").setDescription("Create (or update) a quota reward role.")
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
                    s.setName("delete").setDescription("Delete a quota reward role. Omit role to pick from a numbered list.")
                        .addRoleOption((o) => o.setName("role").setDescription("Reward role")),
                )
                .addSubcommand((s) => s.setName("list").setDescription("List all configured quota reward roles."))
                .addSubcommand((s) => s.setName("force-eval").setDescription("Immediately run the Fixed-mode quota reward evaluation for this server."))
                .addSubcommand((s) =>
                    s.setName("set-eval-hour").setDescription("Set the UTC hour Fixed-mode rewards are evaluated at.")
                        .addIntegerOption((o) => o.setName("hour").setDescription("UTC hour (0-23)").setRequired(true).setMinValue(0).setMaxValue(23)),
                ),
        )
        .addSubcommandGroup((g) =>
            g.setName("session").setDescription("Manage a user's session history.")
                .addSubcommand((s) =>
                    s.setName("view").setDescription("View a user's recent activity sessions.")
                        .addUserOption((o) => o.setName("user").setDescription("Target user").setRequired(true)),
                )
                .addSubcommand((s) =>
                    s.setName("delete").setDescription("Delete one specific session (see the #id in `session view`).")
                        .addUserOption((o) => o.setName("user").setDescription("Target user").setRequired(true))
                        .addIntegerOption((o) => o.setName("session_id").setDescription("Session #id").setRequired(true)),
                )
                .addSubcommand((s) =>
                    s.setName("clear").setDescription("Clear all session history for a user.")
                        .addUserOption((o) => o.setName("user").setDescription("Target user").setRequired(true)),
                ),
        )
        .addSubcommandGroup((g) =>
            g.setName("member").setDescription("Manage a specific member's BiomeHunt data.")
                .addSubcommand((s) =>
                    s.setName("force-setup").setDescription("Force-run setup on behalf of a user - resets any existing channel/webhook first.")
                        .addUserOption((o) => o.setName("user").setDescription("Target user").setRequired(true))
                        .addBooleanOption((o) => o.setName("dm_user").setDescription("DM them the webhook URL? Default false. Ignored when adopting an existing channel."))
                        .addChannelOption((o) =>
                            o.setName("channel").setDescription("Adopt this EXISTING channel instead of creating a new one (requires webhook_url too)")
                                .addChannelTypes(ChannelType.GuildText),
                        )
                        .addStringOption((o) => o.setName("webhook_url").setDescription("The existing channel's webhook URL (required if channel is given)")),
                )
                .addSubcommand((s) =>
                    s.setName("hard-delete").setDescription("Wipe ALL of a user's data (channel, sessions, badges, quota status).")
                        .addUserOption((o) => o.setName("user").setDescription("Target user").setRequired(true)),
                )
                .addSubcommand((s) =>
                    s.setName("soft-delete").setDescription("Remove a user's channel and sessions, but keep badges and quota status.")
                        .addUserOption((o) => o.setName("user").setDescription("Target user").setRequired(true)),
                )
                .addSubcommand((s) =>
                    s.setName("reset-channel").setDescription("Remove only a user's macro channel - all other data stays.")
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
                    s.setName("decrement-biome").setDescription("Remove the N most recent finds of a biome for a user.")
                        .addUserOption((o) => o.setName("user").setDescription("Target user").setRequired(true))
                        .addStringOption((o) => o.setName("biome").setDescription("Biome").setRequired(true).addChoices(...BIOME_ONLY_CHOICES))
                        .addIntegerOption((o) => o.setName("amount").setDescription("How many to remove (default 1)").setMinValue(1)),
                )
                .addSubcommand((s) =>
                    s.setName("clear-biomes").setDescription("Remove ALL recorded finds of a biome for a user.")
                        .addUserOption((o) => o.setName("user").setDescription("Target user").setRequired(true))
                        .addStringOption((o) => o.setName("biome").setDescription("Biome").setRequired(true).addChoices(...BIOME_ONLY_CHOICES)),
                ),
        )
        .addSubcommandGroup((g) =>
            g.setName("forward").setDescription("Forward detected biomes to a channel.")
                .addSubcommand((s) =>
                    s.setName("set").setDescription("Forward a biome to a channel, optionally pinging a role. Omit channel to remove the forward.")
                        .addStringOption((o) => o.setName("biome").setDescription("Biome").setRequired(true).addChoices(...BIOME_SELECTOR_CHOICES))
                        .addChannelOption((o) => o.setName("channel").setDescription("Destination channel (omit to remove the forward)").addChannelTypes(ChannelType.GuildText))
                        .addRoleOption((o) => o.setName("role").setDescription("Role to ping (optional, requires channel)")),
                )
                .addSubcommand((s) => s.setName("list").setDescription("List all configured biome forwards."))
                .addSubcommand((s) => s.setName("menu").setDescription("Interactive menu to add or remove biome forwards.")),
        ),

    async executeAsSlash(interaction, client) {
        if (!interaction.guild) {
            await interaction.reply({ content: "This command only works in a server.", ephemeral: true });
            return;
        }
        const group = interaction.options.getSubcommandGroup(false);
        const sub = interaction.options.getSubcommand(true);
        const routeKey = group ? `${group}-${sub}` : sub;

        const resolveMember = async (name: string) => {
            const user = interaction.options.getUser(name);
            if (!user) return null;
            return interaction.guild!.members.fetch(user.id).catch(() => null);
        };

        if (routeKey === "counter-force-update") {
            await interaction.deferReply();
            try {
                const result = await forceCounterUpdate(client, interaction.guild.id);
                await interaction.editReply(toReplyPayload(result));
            } catch (err) {
                await interaction.editReply({ ...EmbedFormatter.error(errorMessage(err)), allowedMentions: NO_PINGS });
            }
            return;
        }

        if (routeKey === "session-view") {
            const member = await resolveMember("user");
            if (!member) {
                await interaction.reply({ content: "Could not resolve that member.", ephemeral: true });
                return;
            }
            await interaction.deferReply();
            await replySessionHistory(interaction.guild.id, member, interaction.user.id, (payload) => interaction.editReply({ ...payload, allowedMentions: NO_PINGS }));
            return;
        }

        if (routeKey === "profile") {
            const member = await resolveMember("user");
            if (!member) {
                await interaction.reply({ content: "Could not resolve that member.", ephemeral: true });
                return;
            }
            await interaction.deferReply();
            await runProfileView(interaction.guild.id, member, interaction.user.id, (payload) => interaction.editReply({ ...payload, allowedMentions: NO_PINGS }));
            return;
        }

        if (routeKey === "quotas-delete") {
            await interaction.deferReply();
            const roleId = interaction.options.getRole("role")?.id ?? null;
            await deleteQuotas(interaction.guild.id, roleId, interaction.user.id, (payload) => interaction.editReply({ ...payload, allowedMentions: NO_PINGS }));
            return;
        }

        if (routeKey === "setup") {
            await interaction.deferReply();
            await runEzSetupFlow(interaction.guild, interaction.user.id, (payload) => interaction.editReply({ ...payload, allowedMentions: NO_PINGS }));
            return;
        }

        if (routeKey === "forward-menu") {
            await interaction.deferReply();
            await runForwardConfigFlow(interaction.guild, interaction.user.id, (payload) => interaction.editReply({ ...payload, allowedMentions: NO_PINGS }));
            return;
        }

        await interaction.deferReply();
        try {
            const result = await runSubcommand(routeKey, interaction.guild, client, {
                getString: (name) => interaction.options.getString(name),
                getInteger: (name) => interaction.options.getInteger(name),
                getNumber: (name) => interaction.options.getNumber(name),
                getBoolean: (name) => interaction.options.getBoolean(name),
                getChannelId: async (name) => interaction.options.getChannel(name)?.id ?? null,
                getRoleId: async (name) => interaction.options.getRole(name)?.id ?? null,
                getUserId: async (name) => interaction.options.getUser(name)?.id ?? null,
                getMember: resolveMember,
            });
            await interaction.editReply(toReplyPayload(result));
        } catch (err) {
            await interaction.editReply({ ...EmbedFormatter.error(errorMessage(err)), allowedMentions: NO_PINGS });
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
            if (group === "forward") {
                await runForwardConfigFlow(message.guild, message.author.id, (payload) => message.reply({ ...payload, allowedMentions: NO_PINGS }));
                return;
            }
            await message.reply(EmbedFormatter.info("Run `bh-admin config show` to see the current configuration."));
            return;
        }
        const routeKey = group ? `${group}-${sub}` : sub;

        if (routeKey === "counter-force-update") {
            try {
                const result = await forceCounterUpdate(client, message.guild.id);
                await message.reply(toReplyPayload(result));
            } catch (err) {
                await message.reply({ ...EmbedFormatter.error(errorMessage(err)), allowedMentions: NO_PINGS });
            }
            return;
        }

        if (routeKey === "session-view") {
            const member = await args.getMember("user");
            if (!member) {
                await message.reply("Could not resolve that member. Try pinging them instead.");
                return;
            }
            await replySessionHistory(message.guild.id, member, message.author.id, (payload) => message.reply({ ...payload, allowedMentions: NO_PINGS }));
            return;
        }

        if (routeKey === "profile") {
            const member = await args.getMember("user");
            if (!member) {
                await message.reply("Could not resolve that member. Try pinging them instead.");
                return;
            }
            await runProfileView(message.guild.id, member, message.author.id, (payload) => message.reply({ ...payload, allowedMentions: NO_PINGS }));
            return;
        }

        if (routeKey === "quotas-delete") {
            const role = await args.getRole("role");
            await deleteQuotas(message.guild.id, role?.id ?? null, message.author.id, (payload) => message.reply({ ...payload, allowedMentions: NO_PINGS }));
            return;
        }

        if (routeKey === "setup") {
            await runEzSetupFlow(message.guild, message.author.id, (payload) => message.reply({ ...payload, allowedMentions: NO_PINGS }));
            return;
        }

        if (routeKey === "forward-menu") {
            await runForwardConfigFlow(message.guild, message.author.id, (payload) => message.reply({ ...payload, allowedMentions: NO_PINGS }));
            return;
        }

        try {
            const result = await runSubcommand(routeKey, message.guild, client, {
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
            await message.reply({ ...EmbedFormatter.error(errorMessage(err)), allowedMentions: NO_PINGS });
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

async function runSubcommand(sub: string, guild: Guild, client: BotClient, args: ArgReader): Promise<string | ContainerBuilder> {
    const guildId = guild.id;

    switch (sub) {
        case "config-show":
            return showConfig(guildId);
        case "config-test":
            return testConfig(guildId);
        case "config-reset":
            return resetConfig(guildId);
        case "activity-set":
            return setActivity(
                guildId,
                requireNumber(args.getInteger("session_gap_minutes"), "session_gap_minutes"),
                requireNumber(args.getInteger("idle_minutes"), "idle_minutes"),
                requireNumber(args.getInteger("inactive_hours"), "inactive_hours"),
            );
        case "activity-reset":
            return resetActivity(guildId);
        case "activity-delete": {
            const hours = args.getNumber("hours");
            if (hours === null) throw new BiomeHuntError("Missing required argument: hours");
            return deleteActivity(guildId, hours);
        }
        case "activity-set-role": {
            const type = args.getString("type") as ActivityStatus | null;
            const roleId = await args.getRoleId("role");
            if (!type) throw new BiomeHuntError("Missing required argument: type");
            return setActivityRole(guildId, type, roleId);
        }
        case "categories-auto-create": {
            const enabled = args.getBoolean("enabled");
            if (enabled === null) throw new BiomeHuntError("Missing required argument: enabled");
            return setAutoCreateCategories(guildId, enabled);
        }
        case "categories-add": {
            const id = await args.getChannelId("category");
            if (!id) throw new BiomeHuntError("Missing required argument: category");
            return addCategory(guildId, id);
        }
        case "categories-remove": {
            const id = await args.getChannelId("category");
            if (!id) throw new BiomeHuntError("Missing required argument: category");
            return removeCategory(guildId, id);
        }
        case "badges-award": {
            const id = await args.getUserId("user");
            const badge = requireBadge(args.getString("badge"));
            if (!id) throw new BiomeHuntError("Missing required argument: user");
            return awardBadge(guildId, id, badge);
        }
        case "badges-take": {
            const id = await args.getUserId("user");
            const badge = requireBadge(args.getString("badge"));
            if (!id) throw new BiomeHuntError("Missing required argument: user");
            return takeBadge(guildId, id, badge);
        }
        case "badges-set": {
            const badge = requireBadge(args.getString("badge"));
            const roleId = await args.getRoleId("role");
            return setBadges(guildId, badge, roleId);
        }
        case "badges-list":
            return listBadges(guildId);
        case "flag-set": {
            const flag = args.getString("flag") as FlagName | null;
            const enabled = args.getBoolean("enabled");
            if (!flag) throw new BiomeHuntError("Missing required argument: flag");
            if (enabled === null) throw new BiomeHuntError("Missing required argument: enabled");
            return setFlag(guildId, flag, enabled);
        }
        case "flag-list":
            return listFlags(guildId);
        case "economy-grant": {
            const id = await args.getUserId("user");
            if (!id) throw new BiomeHuntError("Missing required argument: user");
            return grantEconomy(guildId, id, args.getInteger("seeds"), args.getInteger("xp"));
        }
        case "forward-set": {
            const biome = args.getString("biome");
            const channelId = await args.getChannelId("channel");
            const roleId = await args.getRoleId("role");
            if (!biome) throw new BiomeHuntError("Missing required argument: biome");
            return setForward(guildId, biome, channelId, roleId);
        }
        case "forward-list":
            return listForwards(guildId);
        case "counter-set": {
            const id = await args.getChannelId("channel");
            if (!id) throw new BiomeHuntError("Missing required argument: channel");
            return setCounterChannel(guildId, id);
        }
        case "counter-disable":
            return disableCounter(guildId);
        case "quotas-create": {
            const roleId = await args.getRoleId("role");
            const mode = args.getString("mode")?.toUpperCase() as QuotaRoleMode | null;
            const quotaHours = args.getNumber("quota_hours");
            const quotaWindowHours = args.getInteger("quota_window_hours");
            const accessDurationDays = args.getInteger("access_duration_days");
            if (!roleId || !mode) throw new BiomeHuntError("Missing required argument: role or mode.");
            return createQuota(
                guildId,
                roleId,
                mode,
                requireNumber(quotaHours, "quota_hours"),
                requireNumber(quotaWindowHours, "quota_window_hours"),
                accessDurationDays,
            );
        }
        case "quotas-list":
            return listQuotas(guildId);
        case "quotas-force-eval":
            return forceQuotaEval(client, guildId);
        case "quotas-set-eval-hour": {
            const hour = args.getInteger("hour");
            if (hour === null) throw new BiomeHuntError("Missing required argument: hour");
            return setQuotaEvalHour(guildId, hour);
        }
        case "session-delete": {
            const id = await args.getUserId("user");
            const sessionId = args.getInteger("session_id");
            if (!id) throw new BiomeHuntError("Missing required argument: user");
            if (sessionId === null) throw new BiomeHuntError("Missing required argument: session_id");
            return deleteActivitySession(guildId, id, sessionId);
        }
        case "session-clear": {
            const id = await args.getUserId("user");
            if (!id) throw new BiomeHuntError("Missing required argument: user");
            return clearActivitySessions(guildId, id);
        }
        case "member-force-setup": {
            const member = await args.getMember("user");
            if (!member) throw new BiomeHuntError("Could not resolve that member.");
            const dmUser = args.getBoolean("dm_user") ?? false;
            const channelId = await args.getChannelId("channel");
            const webhookUrl = args.getString("webhook_url");

            if (channelId && !webhookUrl) throw new BiomeHuntError("webhook_url is required when adopting an existing channel.");
            if (webhookUrl && !channelId) throw new BiomeHuntError("channel is required when providing a webhook_url.");

            let adopt: AdoptParams | null = null;
            if (channelId && webhookUrl) {
                const channel = await guild.channels.fetch(channelId).catch(() => null);
                if (!channel || channel.type !== ChannelType.GuildText) throw new BiomeHuntError("That channel isn't a valid text channel.");
                adopt = { channel, webhookUrl };
            }

            return forceSetupMember(client, guild, member, dmUser, adopt);
        }
        case "member-hard-delete": {
            const id = await args.getUserId("user");
            if (!id) throw new BiomeHuntError("Missing required argument: user");
            return hardDeleteMember(client, guildId, id);
        }
        case "member-soft-delete": {
            const id = await args.getUserId("user");
            if (!id) throw new BiomeHuntError("Missing required argument: user");
            return softDeleteMember(client, guildId, id);
        }
        case "member-reset-channel": {
            const id = await args.getUserId("user");
            if (!id) throw new BiomeHuntError("Missing required argument: user");
            return resetMemberChannel(client, guildId, id);
        }
        case "member-pause": {
            const id = await args.getUserId("user");
            if (!id) throw new BiomeHuntError("Missing required argument: user");
            return pauseMember(guildId, id);
        }
        case "member-unpause": {
            const id = await args.getUserId("user");
            if (!id) throw new BiomeHuntError("Missing required argument: user");
            return unpauseMember(guildId, id);
        }
        case "member-decrement-biome": {
            const id = await args.getUserId("user");
            const biome = args.getString("biome");
            const amount = args.getInteger("amount") ?? 1;
            if (!id) throw new BiomeHuntError("Missing required argument: user");
            if (!biome) throw new BiomeHuntError("Missing required argument: biome");
            return decrementMemberBiome(guildId, id, biome, amount);
        }
        case "member-clear-biomes": {
            const id = await args.getUserId("user");
            const biome = args.getString("biome");
            if (!id) throw new BiomeHuntError("Missing required argument: user");
            if (!biome) throw new BiomeHuntError("Missing required argument: biome");
            return clearMemberBiomes(guildId, id, biome);
        }
        default:
            throw new BiomeHuntError(`Unknown subcommand: ${sub}`);
    }
}

async function replySessionHistory(
    guildId: string,
    member: GuildMember,
    invokerId: string,
    respond: (payload: ConfirmPayload | FormattedReply) => Promise<Message>,
): Promise<void> {
    const sessions = await getSessionHistory(guildId, member.id);
    if (sessions === null) {
        await respond(EmbedFormatter.info(`<@${member.id}> doesn't have a profile yet.`));
        return;
    }
    if (sessions.length === 0) {
        await respond(EmbedFormatter.info(`<@${member.id}> has no activity recorded yet.`));
        return;
    }

    const pages = Math.max(Math.ceil(sessions.length / SESSIONS_PER_PAGE), 1);
    const render = (page: number, interactive: boolean): ConfirmPayload => ({
        flags: MessageFlags.IsComponentsV2,
        components: [
            buildHistoryContainer(sessions, member, page),
            ...(interactive ? [buildPaginationRow(page, pages)] : []),
        ],
    });

    const msg = await respond(render(0, pages > 1));
    if (pages <= 1) return;

    attachPagination(msg, { invokerId, pages, render });
}

/** Admin/config results routinely echo a role back (`"The role is now <@&...>"`) - `NO_PINGS`
 * keeps the mention visible without actually pinging the role just because it showed up on a report. */
function toReplyPayload(result: string | ContainerBuilder): FormattedReply {
    if (typeof result === "string") return { ...EmbedFormatter.success(result), allowedMentions: NO_PINGS };
    return { flags: MessageFlags.IsComponentsV2, components: [result], allowedMentions: NO_PINGS };
}

function errorMessage(err: unknown): string {
    if (err instanceof BiomeHuntError) return err.message;
    logger.error(err instanceof Error ? err : new Error(String(err)));
    return getFailureQuip();
}
