import type { Guild, GuildMember } from "discord.js";
import { ChannelType, type ContainerBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { type CommandArgs, type CommandContext, defineCommand, paginate } from "@/define";
import { CommandCategory } from "@/types";
import { EmbedFormatter, type FormattedReply, NO_PINGS } from "@/utils/format";
import { getAwardableBadges, getBadgeMeta, getBiomeBadges, resolveBadgeSlug } from "../constants/badges.constants";
import { biomeAutocompleteChoices, MAX_DISCORD_CHOICES } from "../constants/biomes.constants";
import { runEzSetupFlow } from "../flows/ez-setup.flow";
import { runDelayedForwardConfigFlow, runForwardConfigFlow } from "../flows/forward-config.flow";
import { getGuildFlags } from "../repository/flags.repository";
import { clearActivitySessions, deleteActivitySession } from "../services/activity-session.service";
import { awardBadge, listBadges, setBadges, takeBadge } from "../services/badge.service";
import { listDelayedForwards, setDelayedForward } from "../services/delayed-forward.service";
import { grantEconomy } from "../services/economy.service";
import { listForwards, setForward } from "../services/forward.service";
import {
    type AdoptParams,
    clearMemberBiomes,
    decrementMemberBiome,
    deleteMemberEverything,
    forceSetupMember,
    incrementMemberBiome,
    MAX_MANUAL_FINDS,
    pauseMember,
    softDeleteMember,
    unlinkMember,
    unpauseMember,
} from "../services/member.service";
import { settings } from "../settings";
import { type Badge, BiomeHuntError } from "../types";
import { defaultFlagsDeps, flagsView } from "../views/flags.view";
import { openProfileView } from "../views/profile.view";
import { defaultQuotasDeps, loadQuotasInput, quotasView } from "../views/quotas.view";
import { defaultSettingsDeps, loadSettingsInput, settingsView } from "../views/settings.view";
import { buildHistoryContainer, getSessionHistory, SESSIONS_PER_PAGE } from "../views/stats-builders";
import { defaultVoteReviewDeps, voteReviewView } from "../views/vote-review.view";

/**
 * Autocomplete for a `badge` option - `badges set` only offers biome badges (the ones a role can be
 * attached to), award/take also offer `DELETED`. Value is the badge's slug (easy to type in prefix
 * mode), resolved back via `resolveBadgeSlug`.
 */
function badgeAutocompleteChoices(typed: string, sub: string | null): Array<{ name: string; value: string }> {
    const badges = sub === "set" ? getBiomeBadges() : getAwardableBadges();
    const needle = typed.trim().toLowerCase();
    return badges
        .map((b) => getBadgeMeta(b))
        .filter((m) => !needle || m.display.toLowerCase().includes(needle) || m.slug.includes(needle))
        .slice(0, MAX_DISCORD_CHOICES)
        .map((m) => ({ name: m.display, value: m.slug }));
}
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
    guildOnly: true,
    onMissingSubcommand: "run",

    options: new SlashCommandBuilder()
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand((s) => s.setName("setup").setDescription("Guided step-by-step setup wizard."))
        .addSubcommand((s) => s.setName("flags").setDescription("Turn optional features on or off for this server."))
        .addSubcommand((s) => s.setName("quotas").setDescription("Quota reward roles members earn by macroing."))
        .addSubcommand((s) =>
            s.setName("settings").setDescription("Activity, status roles, macro channels, auto-delete and the live counter."),
        )
        .addSubcommand((s) =>
            s
                .setName("profile")
                .setDescription("View a user's BiomeHunt profile.")
                .addUserOption((o) => o.setName("user").setDescription("Target user").setRequired(true)),
        )
        .addSubcommand((s) =>
            s
                .setName("review-voting")
                .setDescription("Review a rare-biome vote's voters and, if needed, override its decision.")
                .addStringOption((o) => o.setName("id").setDescription("Vote id (shown on the forward message)").setRequired(true)),
        )
        .addSubcommandGroup((g) =>
            g
                .setName("badges")
                .setDescription("Manage badges (biome-discovery and bot-triggered).")
                .addSubcommand((s) =>
                    s
                        .setName("award")
                        .setDescription("Manually grant a badge to a user.")
                        .addUserOption((o) => o.setName("user").setDescription("Target user").setRequired(true))
                        .addStringOption((o) => o.setName("badge").setDescription("Badge").setRequired(true).setAutocomplete(true)),
                )
                .addSubcommand((s) =>
                    s
                        .setName("take")
                        .setDescription("Manually revoke a badge from a user.")
                        .addUserOption((o) => o.setName("user").setDescription("Target user").setRequired(true))
                        .addStringOption((o) => o.setName("badge").setDescription("Badge").setRequired(true).setAutocomplete(true)),
                )
                .addSubcommand((s) =>
                    s
                        .setName("set")
                        .setDescription("Configure the role a badge grants. Leave role empty to unconfigure it.")
                        .addStringOption((o) => o.setName("badge").setDescription("Badge").setRequired(true).setAutocomplete(true))
                        .addRoleOption((o) => o.setName("role").setDescription("Role to grant (leave empty to unconfigure)")),
                )
                .addSubcommand((s) => s.setName("list").setDescription("List all badges and their current role configuration.")),
        )
        .addSubcommandGroup((g) =>
            g
                .setName("economy")
                .setDescription("Manual Seeds/XP balance adjustments.")
                .addSubcommand((s) =>
                    s
                        .setName("grant")
                        .setDescription("Grant (or take, with a negative number) Seeds/XP.")
                        .addUserOption((o) => o.setName("user").setDescription("Target user").setRequired(true))
                        .addIntegerOption((o) => o.setName("seeds").setDescription("Seeds delta (negative to take away)"))
                        .addIntegerOption((o) => o.setName("xp").setDescription("XP delta (negative to take away)")),
                ),
        )
        .addSubcommandGroup((g) =>
            g
                .setName("session")
                .setDescription("Manage a user's session history.")
                .addSubcommand((s) =>
                    s
                        .setName("view")
                        .setDescription("View a user's recent activity sessions.")
                        .addUserOption((o) => o.setName("user").setDescription("Target user").setRequired(true)),
                )
                .addSubcommand((s) =>
                    s
                        .setName("delete")
                        .setDescription("Delete one specific session (see the #id in `session view`).")
                        .addUserOption((o) => o.setName("user").setDescription("Target user").setRequired(true))
                        .addIntegerOption((o) => o.setName("session_id").setDescription("Session #id").setRequired(true)),
                )
                .addSubcommand((s) =>
                    s
                        .setName("clear")
                        .setDescription("Clear all session history for a user.")
                        .addUserOption((o) => o.setName("user").setDescription("Target user").setRequired(true)),
                ),
        )
        .addSubcommandGroup((g) =>
            g
                .setName("member")
                .setDescription("Manage a specific member's BiomeHunt data.")
                .addSubcommand((s) =>
                    s
                        .setName("force-setup")
                        .setDescription("Force-run setup on behalf of a user - resets any existing channel/webhook first.")
                        .addUserOption((o) => o.setName("user").setDescription("Target user").setRequired(true))
                        .addBooleanOption((o) =>
                            o
                                .setName("dm_user")
                                .setDescription("DM them the webhook URL? Default false. Ignored when adopting an existing channel."),
                        )
                        .addChannelOption((o) =>
                            o
                                .setName("channel")
                                .setDescription("Adopt this EXISTING channel instead of creating a new one (requires webhook_url too)")
                                .addChannelTypes(ChannelType.GuildText),
                        )
                        .addStringOption((o) =>
                            o.setName("webhook_url").setDescription("The existing channel's webhook URL (required if channel is given)"),
                        ),
                )
                .addSubcommand((s) =>
                    s
                        .setName("hard-delete")
                        .setDescription("Wipe ALL of a user's data (channel, sessions, badges, quota status).")
                        .addUserOption((o) => o.setName("user").setDescription("Target user").setRequired(true)),
                )
                .addSubcommand((s) =>
                    s
                        .setName("soft-delete")
                        .setDescription("Remove a user's channel and sessions, but keep badges and quota status.")
                        .addUserOption((o) => o.setName("user").setDescription("Target user").setRequired(true)),
                )
                .addSubcommand((s) =>
                    s
                        .setName("reset-channel")
                        .setDescription("Remove only a user's macro channel - all other data stays.")
                        .addUserOption((o) => o.setName("user").setDescription("Target user").setRequired(true)),
                )
                .addSubcommand((s) =>
                    s
                        .setName("pause")
                        .setDescription("Exempt a user from inactivity auto-delete.")
                        .addUserOption((o) => o.setName("user").setDescription("Target user").setRequired(true)),
                )
                .addSubcommand((s) =>
                    s
                        .setName("unpause")
                        .setDescription("Re-expose a user to inactivity auto-delete.")
                        .addUserOption((o) => o.setName("user").setDescription("Target user").setRequired(true)),
                )
                .addSubcommand((s) =>
                    s
                        .setName("decrement-biome")
                        .setDescription("Remove the N most recent finds of a biome for a user.")
                        .addUserOption((o) => o.setName("user").setDescription("Target user").setRequired(true))
                        .addStringOption((o) => o.setName("biome").setDescription("Biome").setRequired(true).setAutocomplete(true))
                        .addIntegerOption((o) => o.setName("amount").setDescription("How many to remove (default 1)").setMinValue(1)),
                )
                .addSubcommand((s) =>
                    s
                        .setName("increment-biome")
                        .setDescription("Record N finds of a biome on a user's profile (no Seeds/XP/badge is granted).")
                        .addUserOption((o) => o.setName("user").setDescription("Target user").setRequired(true))
                        .addStringOption((o) => o.setName("biome").setDescription("Biome").setRequired(true).setAutocomplete(true))
                        .addIntegerOption((o) =>
                            o.setName("amount").setDescription("How many to add (default 1)").setMinValue(1).setMaxValue(MAX_MANUAL_FINDS),
                        ),
                )
                .addSubcommand((s) =>
                    s
                        .setName("clear-biomes")
                        .setDescription("Remove ALL recorded finds of a biome for a user.")
                        .addUserOption((o) => o.setName("user").setDescription("Target user").setRequired(true))
                        .addStringOption((o) => o.setName("biome").setDescription("Biome").setRequired(true).setAutocomplete(true)),
                ),
        )
        .addSubcommandGroup((g) =>
            g
                .setName("forward")
                .setDescription("Forward detected biomes to a channel.")
                .addSubcommand((s) =>
                    s
                        .setName("set")
                        .setDescription("Forward a biome to a channel, optionally pinging a role. Omit channel to remove the forward.")
                        .addStringOption((o) => o.setName("biome").setDescription("Biome").setRequired(true).setAutocomplete(true))
                        .addChannelOption((o) =>
                            o
                                .setName("channel")
                                .setDescription("Destination channel (omit to remove the forward)")
                                .addChannelTypes(ChannelType.GuildText),
                        )
                        .addRoleOption((o) => o.setName("role").setDescription("Role to ping (optional, requires channel)")),
                )
                .addSubcommand((s) => s.setName("list").setDescription("List all configured biome forwards."))
                .addSubcommand((s) => s.setName("menu").setDescription("Interactive menu to add or remove biome forwards.")),
        )
        .addSubcommandGroup((g) =>
            g
                .setName("delayed-forward")
                .setDescription("Forward detected biomes to a channel after a delay.")
                .addSubcommand((s) =>
                    s
                        .setName("set")
                        .setDescription("Delay-forward a biome to a channel, optionally pinging a role. Omit channel to remove it.")
                        .addStringOption((o) => o.setName("biome").setDescription("Biome").setRequired(true).setAutocomplete(true))
                        .addChannelOption((o) =>
                            o
                                .setName("channel")
                                .setDescription("Destination channel (omit to remove the delayed forward)")
                                .addChannelTypes(ChannelType.GuildText),
                        )
                        .addIntegerOption((o) =>
                            o
                                .setName("delay")
                                .setDescription("Seconds to wait after the find (required with channel)")
                                .addChoices(...settings.delayedForward.delayChoicesS.map((d) => ({ name: `${d}s`, value: d }))),
                        )
                        .addRoleOption((o) => o.setName("role").setDescription("Role to ping (optional, requires channel)")),
                )
                .addSubcommand((s) => s.setName("list").setDescription("List all configured delayed biome forwards."))
                .addSubcommand((s) => s.setName("menu").setDescription("Interactive menu to add or remove delayed biome forwards.")),
        ),

    // Biome options autocomplete from the live registry - fixed choices can't follow `/bh-owner biome` changes and cap at 25.
    async executeAutocomplete(interaction) {
        const focused = interaction.options.getFocused(true);
        if (focused.name === "badge")
            return interaction.respond(badgeAutocompleteChoices(focused.value, interaction.options.getSubcommand(false)));
        if (focused.name !== "biome") return interaction.respond([]);
        const group = interaction.options.getSubcommandGroup(false);
        const forward = group === "forward" || group === "delayed-forward";
        // Forwards take ALL/CAT: shortcuts and only live biomes; member corrections can also target a disabled biome's old finds.
        await interaction.respond(biomeAutocompleteChoices(focused.value, forward ? { selectors: true } : { which: "all" }));
    },

    async run(ctx) {
        const group = ctx.args.getSubcommandGroup();
        const sub = ctx.args.getSubcommand();

        // onMissingSubcommand: "run" - a bare `!bh-admin forward` / `delayed-forward` opens its menu; any other
        // missing/unknown subcommand gets the framework's usage.
        if (!sub) {
            // Only a truly bare `forward` opens the menu - `forward lst` (a typo) gets the usage.
            const nothingAfterGroup = ctx.raw.kind === "prefix" && ctx.raw.args.getRawArgs().length === 0;
            if (group === "forward" && nothingAfterGroup) {
                await runForwardConfigFlow(ctx, ctx.guild.id);
                return;
            }
            if (group === "delayed-forward" && nothingAfterGroup) {
                await runDelayedForwardConfigFlow(ctx, ctx.guild.id);
                return;
            }
            await ctx.replyUsage();
            return;
        }
        const routeKey = group ? `${group}-${sub}` : sub;

        if (routeKey === "session-view") {
            const member = await requireMember(ctx.args, "user");
            await ctx.defer();
            await replySessionHistory(ctx, ctx.guild.id, member);
            return;
        }

        if (routeKey === "profile") {
            const member = await requireMember(ctx.args, "user");
            await ctx.defer();
            await openProfileView(ctx, ctx.guild.id, member);
            return;
        }

        if (routeKey === "review-voting") {
            const voteId = ctx.args.getString("id");
            if (!voteId) throw new BiomeHuntError("Missing required argument: id");
            await ctx.defer();
            await ctx.open(voteReviewView(defaultVoteReviewDeps(ctx.client, voteId)), { voteId, guildId: ctx.guild.id });
            return;
        }

        if (routeKey === "flags") {
            await ctx.defer();
            await ctx.open(flagsView(defaultFlagsDeps), { guildId: ctx.guild.id, flags: await getGuildFlags(ctx.guild.id) });
            return;
        }

        if (routeKey === "quotas") {
            await ctx.defer();
            await ctx.open(quotasView(defaultQuotasDeps(ctx.client, ctx.guild)), await loadQuotasInput(ctx.guild.id));
            return;
        }

        if (routeKey === "settings") {
            await ctx.defer();
            await ctx.open(settingsView(defaultSettingsDeps(ctx.client, ctx.guild)), await loadSettingsInput(ctx.guild.id));
            return;
        }

        if (routeKey === "setup") {
            await ctx.defer();
            await runEzSetupFlow(ctx, ctx.guild.id);
            return;
        }

        if (routeKey === "forward-menu") {
            await ctx.defer();
            await runForwardConfigFlow(ctx, ctx.guild.id);
            return;
        }

        if (routeKey === "delayed-forward-menu") {
            await ctx.defer();
            await runDelayedForwardConfigFlow(ctx, ctx.guild.id);
            return;
        }

        await ctx.defer();
        await ctx.reply(toReplyPayload(await runSubcommand(routeKey, ctx.guild, ctx.client, ctx.args)));
    },
});

/** Resolves an option's id, e.g. `await idOf(args.getChannel("channel"))` -> `"123"` or `null`. */
async function idOf(entity: Promise<{ id: string } | null>): Promise<string | null> {
    return (await entity)?.id ?? null;
}

/** For a required user option - absent is the only way to get null (unresolvable already throws). */
async function requireMember(args: CommandArgs, name: string): Promise<GuildMember> {
    const member = await args.getMember(name);
    if (!member) throw new BiomeHuntError(`Missing required argument: \`${name}\``);
    return member;
}

async function runSubcommand(sub: string, guild: Guild, client: BotClient, args: CommandArgs): Promise<string | ContainerBuilder> {
    const guildId = guild.id;

    switch (sub) {
        case "badges-award": {
            const id = await idOf(args.getUser("user"));
            const badge = requireBadge(args.getString("badge"));
            if (!id) throw new BiomeHuntError("Missing required argument: user");
            return awardBadge(guildId, id, badge);
        }
        case "badges-take": {
            const id = await idOf(args.getUser("user"));
            const badge = requireBadge(args.getString("badge"));
            if (!id) throw new BiomeHuntError("Missing required argument: user");
            return takeBadge(guildId, id, badge);
        }
        case "badges-set": {
            const badge = requireBadge(args.getString("badge"));
            const roleId = await idOf(args.getRole("role"));
            return setBadges(guildId, badge, roleId);
        }
        case "badges-list":
            return listBadges(guildId);
        case "economy-grant": {
            const id = await idOf(args.getUser("user"));
            if (!id) throw new BiomeHuntError("Missing required argument: user");
            return grantEconomy(guildId, id, args.getInteger("seeds"), args.getInteger("xp"));
        }
        case "forward-set": {
            const biome = args.getString("biome");
            const channelId = await idOf(args.getChannel("channel"));
            const roleId = await idOf(args.getRole("role"));
            if (!biome) throw new BiomeHuntError("Missing required argument: biome");
            return setForward(guildId, biome, channelId, roleId);
        }
        case "forward-list":
            return listForwards(guildId);
        case "delayed-forward-set": {
            const biome = args.getString("biome");
            const channelId = await idOf(args.getChannel("channel"));
            const roleId = await idOf(args.getRole("role"));
            if (!biome) throw new BiomeHuntError("Missing required argument: biome");
            return setDelayedForward(guildId, biome, channelId, roleId, args.getInteger("delay"));
        }
        case "delayed-forward-list":
            return listDelayedForwards(guildId);
        case "session-delete": {
            const id = await idOf(args.getUser("user"));
            const sessionId = args.getInteger("session_id");
            if (!id) throw new BiomeHuntError("Missing required argument: user");
            if (sessionId === null) throw new BiomeHuntError("Missing required argument: session_id");
            return deleteActivitySession(guildId, id, sessionId);
        }
        case "session-clear": {
            const id = await idOf(args.getUser("user"));
            if (!id) throw new BiomeHuntError("Missing required argument: user");
            return clearActivitySessions(guildId, id);
        }
        case "member-force-setup": {
            const member = await args.getMember("user");
            if (!member) throw new BiomeHuntError("Could not resolve that member.");
            const dmUser = args.getBoolean("dm_user") ?? false;
            const channelId = await idOf(args.getChannel("channel"));
            const webhookUrl = args.getString("webhook_url");

            if (channelId && !webhookUrl) throw new BiomeHuntError("webhook_url is required when adopting an existing channel.");
            if (webhookUrl && !channelId) throw new BiomeHuntError("channel is required when providing a webhook_url.");

            let adopt: AdoptParams | null = null;
            if (channelId && webhookUrl) {
                const channel = await guild.channels.fetch(channelId).catch(() => null);
                if (!channel || channel.type !== ChannelType.GuildText)
                    throw new BiomeHuntError("That channel isn't a valid text channel.");
                adopt = { channel, webhookUrl };
            }

            return forceSetupMember(client, guild, member, dmUser, adopt);
        }
        case "member-hard-delete": {
            const id = await idOf(args.getUser("user"));
            if (!id) throw new BiomeHuntError("Missing required argument: user");
            return deleteMemberEverything(client, guildId, id);
        }
        case "member-soft-delete": {
            const id = await idOf(args.getUser("user"));
            if (!id) throw new BiomeHuntError("Missing required argument: user");
            return softDeleteMember(client, guildId, id);
        }
        case "member-reset-channel": {
            const id = await idOf(args.getUser("user"));
            if (!id) throw new BiomeHuntError("Missing required argument: user");
            await unlinkMember(client, guildId, id);
            return `<@${id}>'s macro channel removed. All other data kept. They can run \`/bh setup\` again.`;
        }
        case "member-pause": {
            const id = await idOf(args.getUser("user"));
            if (!id) throw new BiomeHuntError("Missing required argument: user");
            return pauseMember(guildId, id);
        }
        case "member-unpause": {
            const id = await idOf(args.getUser("user"));
            if (!id) throw new BiomeHuntError("Missing required argument: user");
            return unpauseMember(guildId, id);
        }
        case "member-decrement-biome": {
            const id = await idOf(args.getUser("user"));
            const biome = args.getString("biome");
            const amount = args.getInteger("amount") ?? 1;
            if (!id) throw new BiomeHuntError("Missing required argument: user");
            if (!biome) throw new BiomeHuntError("Missing required argument: biome");
            return decrementMemberBiome(guildId, id, biome, amount);
        }
        case "member-increment-biome": {
            const id = await idOf(args.getUser("user"));
            const biome = args.getString("biome");
            const amount = args.getInteger("amount") ?? 1;
            if (!id) throw new BiomeHuntError("Missing required argument: user");
            if (!biome) throw new BiomeHuntError("Missing required argument: biome");
            return incrementMemberBiome(guildId, id, biome, amount);
        }
        case "member-clear-biomes": {
            const id = await idOf(args.getUser("user"));
            const biome = args.getString("biome");
            if (!id) throw new BiomeHuntError("Missing required argument: user");
            if (!biome) throw new BiomeHuntError("Missing required argument: biome");
            return clearMemberBiomes(guildId, id, biome);
        }
        default:
            throw new BiomeHuntError(`Unknown subcommand: ${sub}`);
    }
}

async function replySessionHistory(ctx: CommandContext, guildId: string, member: GuildMember): Promise<void> {
    const sessions = await getSessionHistory(guildId, member.id);
    if (sessions === null) {
        await ctx.reply({ ...EmbedFormatter.info(`<@${member.id}> doesn't have a profile yet.`), allowedMentions: NO_PINGS });
        return;
    }
    if (sessions.length === 0) {
        await ctx.reply({ ...EmbedFormatter.info(`<@${member.id}> has no activity recorded yet.`), allowedMentions: NO_PINGS });
        return;
    }

    const pages = Math.max(Math.ceil(sessions.length / SESSIONS_PER_PAGE), 1);
    await ctx.open(
        paginate({
            name: "biomehunt.session-history",
            pages,
            renderPage: (page) => ({ flags: MessageFlags.IsComponentsV2, components: [buildHistoryContainer(sessions, member, page)] }),
        }),
        undefined,
    );
}

/** Admin/config results routinely echo a role back (`"The role is now <@&...>"`) - `NO_PINGS`
 * keeps the mention visible without actually pinging the role just because it showed up on a report. */
function toReplyPayload(result: string | ContainerBuilder): FormattedReply {
    if (typeof result === "string") return { ...EmbedFormatter.success(result), allowedMentions: NO_PINGS };
    return { flags: MessageFlags.IsComponentsV2, components: [result], allowedMentions: NO_PINGS };
}
