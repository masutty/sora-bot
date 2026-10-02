import {
    ChannelType,
    type Guild,
    MessageFlags,
    type SlashCommandBuilder,
    type SlashCommandStringOption,
    type SlashCommandSubcommandGroupBuilder,
} from "discord.js";
import { type CommandContext, confirm, paginate } from "@/define";
import { EmbedFormatter, NO_PINGS } from "@/utils/format";
import { formatBiomeName } from "../constants/biomes.constants";
import { getDelayedForwardConfigs } from "../repository/delayed-forwards.repository";
import { getForwardConfigs } from "../repository/forwards.repository";
import { getActiveNetworkGuilds, getNetworkGuild, isNetworkBanned } from "../repository/network.repository";
import { getNetworkStats, getRecentNetworkAlerts } from "../repository/network-posts.repository";
import { defaultAnnounceDeps, sendNetworkAnnouncement } from "../services/network-announce.service";
import { loadEligibility, NETWORK_BIOMES } from "../services/network-eligibility.service";
import {
    banFromNetwork,
    decideJoinRequest,
    defaultMembershipDeps,
    forceIntoNetwork,
    removeFromNetwork,
    requireSnowflake,
    unbanFromNetwork,
} from "../services/network-membership.service";
import { defaultNetworkPublishDeps, scheduleSimulatedNetworkPost } from "../services/network-publish.service";
import { closeNetworkVote, defaultNetworkVoteDeps } from "../services/network-vote.service";
import { BiomeHuntError, type NetworkBanKind, type NetworkGuildRow, NetworkStatus } from "../types";
import { buildNetworkOverviewPages, formatAlertLines, type OverviewServer, v2 } from "../views/network.view";
import { buildMirrorContainer, serverNameLink } from "../views/network-mirror.view";

const BAN_KIND_CHOICES = [
    { name: "Guild", value: "guild" },
    { name: "User", value: "user" },
];

/** Discord's text display limit is 4000 - leave room for the lookup's header lines. */
const ANNOUNCE_MAX_CHARS = 1800;
const LOOKUP_ALERTS = 10;

const guildIdOption =
    (desc: string, required = true) =>
    (o: SlashCommandStringOption) =>
        o.setName("guild_id").setDescription(desc).setRequired(required);

function networkGroup(g: SlashCommandSubcommandGroupBuilder): SlashCommandSubcommandGroupBuilder {
    return g
        .setName("network")
        .setDescription("Manage the Network.")
        .addSubcommand((s) =>
            s.setName("approve").setDescription("Approve a pending join request.").addStringOption(guildIdOption("Guild ID")),
        )
        .addSubcommand((s) =>
            s.setName("reject").setDescription("Reject a pending join request.").addStringOption(guildIdOption("Guild ID")),
        )
        .addSubcommand((s) =>
            s.setName("remove").setDescription("Remove a server from the Network.").addStringOption(guildIdOption("Guild ID")),
        )
        .addSubcommand((s) =>
            s
                .setName("force")
                .setDescription("Put a server in the Network without the checklist.")
                .addStringOption(guildIdOption("Guild ID"))
                .addStringOption((o) => o.setName("channel_id").setDescription("Its Network channel ID").setRequired(true)),
        )
        .addSubcommand((s) =>
            s
                .setName("ban")
                .setDescription("Ban a server or user from the whole Network.")
                .addStringOption((o) =>
                    o
                        .setName("kind")
                        .setDescription("What to ban")
                        .setRequired(true)
                        .addChoices(...BAN_KIND_CHOICES),
                )
                .addStringOption((o) => o.setName("target_id").setDescription("Guild or user ID").setRequired(true))
                .addStringOption((o) => o.setName("reason").setDescription("Why (kept for the record)")),
        )
        .addSubcommand((s) =>
            s
                .setName("unban")
                .setDescription("Lift a Network ban.")
                .addStringOption((o) =>
                    o
                        .setName("kind")
                        .setDescription("What to unban")
                        .setRequired(true)
                        .addChoices(...BAN_KIND_CHOICES),
                )
                .addStringOption((o) => o.setName("target_id").setDescription("Guild or user ID").setRequired(true)),
        )
        .addSubcommand((s) =>
            s
                .setName("close-vote")
                .setDescription("Close a Network vote right now.")
                .addStringOption((o) => o.setName("post_id").setDescription("Network Post id").setRequired(true)),
        )
        .addSubcommand((s) =>
            s
                .setName("announce")
                .setDescription("Post an announcement in every Network channel (with a preview first).")
                .addStringOption((o) =>
                    o.setName("message").setDescription("The announcement").setRequired(true).setMaxLength(ANNOUNCE_MAX_CHARS),
                ),
        )
        .addSubcommand((s) =>
            s
                .setName("lookup")
                .setDescription("A server's Network card or a user's Network record, with recent alerts.")
                .addStringOption(guildIdOption("Guild ID", false))
                .addStringOption((o) => o.setName("user_id").setDescription("User ID")),
        )
        .addSubcommand((s) =>
            s.setName("overview").setDescription("Every member and pending server, plus the Network's numbers (last 7 days, right now)."),
        );
}

/** Adds the `network` subcommand group to `/bh-owner`'s builder. */
export function addNetworkOwnerGroup<T extends Pick<SlashCommandBuilder, "addSubcommandGroup">>(builder: T): T {
    builder.addSubcommandGroup(networkGroup);
    return builder;
}

function requireBanKind(raw: string): NetworkBanKind {
    if (raw !== "guild" && raw !== "user") throw new BiomeHuntError("kind must be `guild` or `user`.");
    return raw;
}

/** `/bh-owner network <sub>` - the caller already deferred ephemerally. */
export async function runNetworkOwnerSubcommand(ctx: CommandContext): Promise<void> {
    const sub = ctx.args.getSubcommand();
    const deps = defaultMembershipDeps(ctx.client);
    const ownerId = ctx.user.id;

    switch (sub) {
        case "approve":
        case "reject": {
            const guildId = requireSnowflake(ctx.args.getString("guild_id", true));
            const result = await decideJoinRequest(guildId, ownerId, sub === "approve", deps);
            if (result === "banned") {
                await ctx.reply(EmbedFormatter.warn(`\`${guildId}\` is banned from the Network - its request was rejected instead.`));
                return;
            }
            await ctx.reply(
                result === "ok"
                    ? EmbedFormatter.success(`${sub === "approve" ? "Approved" : "Rejected"} \`${guildId}\`.`)
                    : EmbedFormatter.info(`\`${guildId}\` has no pending request.`),
            );
            return;
        }
        case "remove": {
            const guildId = requireSnowflake(ctx.args.getString("guild_id", true));
            const removed = await removeFromNetwork(guildId, ownerId, deps);
            await ctx.reply(
                removed
                    ? EmbedFormatter.success(`Removed \`${guildId}\` from the Network.`)
                    : EmbedFormatter.info(`\`${guildId}\` is not in the Network.`),
            );
            return;
        }
        case "force":
            return runForce(ctx, ownerId);
        case "ban":
        case "unban": {
            const kind = requireBanKind(ctx.args.getString("kind", true));
            const targetId = requireSnowflake(ctx.args.getString("target_id", true));
            if (sub === "ban") {
                const added = await banFromNetwork(kind, targetId, ownerId, ctx.args.getString("reason"), deps);
                await ctx.reply(
                    added
                        ? EmbedFormatter.success(`Banned ${kind} \`${targetId}\` from the Network.`)
                        : EmbedFormatter.info(`${kind} \`${targetId}\` was already banned.`),
                );
                return;
            }
            const lifted = await unbanFromNetwork(kind, targetId, deps);
            await ctx.reply(
                lifted
                    ? EmbedFormatter.success(`Lifted the Network ban on ${kind} \`${targetId}\`.`)
                    : EmbedFormatter.info(`${kind} \`${targetId}\` was not banned.`),
            );
            return;
        }
        case "close-vote": {
            const postId = ctx.args.getString("post_id", true).trim();
            const result = await closeNetworkVote(postId, ownerId, defaultNetworkVoteDeps(ctx.client));
            const messages = {
                ok: EmbedFormatter.success(`Closed the Network vote on \`${postId}\`.`),
                already_closed: EmbedFormatter.info(`The vote on \`${postId}\` is not open.`),
                not_found: EmbedFormatter.error(`No Network Post \`${postId}\`.`),
            };
            await ctx.reply(messages[result]);
            return;
        }
        case "announce":
            return runAnnounce(ctx);
        case "lookup":
            return runLookup(ctx);
        case "overview":
            return runOverview(ctx);
    }
}

/**
 * Forced entry: the channel must be a plain text or announcement channel of that guild (not a thread
 * or a voice chat), and not one of its local forward channels - Mirrors must never mix into local posts.
 */
async function runForce(ctx: CommandContext, ownerId: string): Promise<void> {
    const guildId = requireSnowflake(ctx.args.getString("guild_id", true));
    const channelId = requireSnowflake(ctx.args.getString("channel_id", true));
    const channel = await ctx.client.channels.fetch(channelId).catch(() => null);
    const isPlainText = channel?.type === ChannelType.GuildText || channel?.type === ChannelType.GuildAnnouncement;
    if (!channel || !isPlainText || channel.guildId !== guildId) {
        throw new BiomeHuntError(`\`${channelId}\` is not a text channel in guild \`${guildId}\`.`);
    }
    const [live, delayed] = await Promise.all([getForwardConfigs(guildId), getDelayedForwardConfigs(guildId)]);
    if ([...live, ...delayed].some((f) => f.channel_id === channelId)) {
        throw new BiomeHuntError(`<#${channelId}> is one of that server's local forward channels - pick another one.`);
    }
    await forceIntoNetwork(guildId, channelId, ownerId, defaultMembershipDeps(ctx.client));
    await ctx.reply(EmbedFormatter.success(`\`${guildId}\` is now a forced Network member, receiving in <#${channelId}>.`));
}

async function runAnnounce(ctx: CommandContext): Promise<void> {
    const text = ctx.args.getString("message", true).trim().slice(0, ANNOUNCE_MAX_CHARS);
    await ctx.open(
        confirm({
            name: "biomehunt.net-announce",
            title: "Post this announcement in every Network channel?",
            fields: [{ label: "Message", value: text }],
            onConfirm: async () => {
                const { sent, total } = await sendNetworkAnnouncement(text, defaultAnnounceDeps(ctx.client));
                return EmbedFormatter.success(`Announcement posted in ${sent} of ${total} Network channel(s).`);
            },
        }),
        undefined,
    );
}

async function runLookup(ctx: CommandContext): Promise<void> {
    const rawGuild = ctx.args.getString("guild_id");
    const rawUser = ctx.args.getString("user_id");
    if (!rawGuild && !rawUser) throw new BiomeHuntError("Give a `guild_id` or a `user_id`.");

    if (rawGuild) {
        const guildId = requireSnowflake(rawGuild);
        const [row, report, banned, alerts] = await Promise.all([
            getNetworkGuild(guildId),
            loadEligibility(guildId),
            isNetworkBanned("guild", guildId),
            getRecentNetworkAlerts({ guildId }, LOOKUP_ALERTS),
        ]);
        const name = ctx.client.guilds.cache.get(guildId)?.name ?? "unknown (bot not in it)";
        const status = row?.status ?? NetworkStatus.NONE;
        const lines = [
            `${serverNameLink(name, row?.invite_url ?? null)} (\`${guildId}\`)`,
            `Status: **${status}**${row?.forced ? " (forced)" : ""}${banned ? " · **BANNED**" : ""}`,
            `Active members (7d): **${report.card.activeMembers}** · Macro hours: **${report.card.macroHours7d}h** (7d) · **${report.card.macroHours30d}h** (30d)`,
            `Low-activity streak: ${row?.low_activity_checks ?? 0} day(s)`,
            "",
            "**Recent alerts**",
            formatAlertLines(alerts),
        ];
        await ctx.reply(EmbedFormatter.plain(lines.join("\n")));
        return;
    }

    const userId = requireSnowflake(rawUser as string);
    const [banned, alerts] = await Promise.all([
        isNetworkBanned("user", userId),
        getRecentNetworkAlerts({ discordUserId: userId }, LOOKUP_ALERTS),
    ]);
    const lines = [`<@${userId}> (\`${userId}\`)${banned ? " · **BANNED**" : ""}`, "", "**Recent alerts**", formatAlertLines(alerts)];
    await ctx.reply(EmbedFormatter.plain(lines.join("\n")));
}

/** A placeholder private server link for simulated Mirrors - real-looking, so the link button renders. */
const SIMULATED_SERVER_LINK = "https://www.roblox.com/share?code=SIMULATED&type=Server";

/**
 * `/bh-owner simulate-biome network:true` - sends one simulated Mirror (marked, no ping, no vote) to
 * the invoking guild's own Network channel, to check the layout without bothering any other server.
 */
export async function runSimulateNetworkMirror(ctx: CommandContext, guild: Guild, biome: string): Promise<void> {
    if (!NETWORK_BIOMES.includes(biome)) throw new BiomeHuntError(`${formatBiomeName(biome)} is not a Network biome.`);
    const row = await getNetworkGuild(guild.id);
    if (!row?.network_channel_id) throw new BiomeHuntError("This server has no Network channel - set one with `/network config`.");
    const channel = await ctx.client.channels.fetch(row.network_channel_id).catch(() => null);
    if (!channel || channel.isDMBased() || !channel.isTextBased())
        throw new BiomeHuntError("I can't post in this server's Network channel.");

    const post = {
        id: "simulated",
        biome,
        origin_name: guild.name,
        origin_icon_url: guild.iconURL(),
        invite_url: row.invite_url,
        server_link: SIMULATED_SERVER_LINK,
    };
    await channel.send({
        components: [buildMirrorContainer({ post, roleId: null, simulated: true })],
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: NO_PINGS,
    });
    await ctx.reply(EmbedFormatter.success(`Simulated Network Mirror of ${formatBiomeName(biome)} sent to <#${channel.id}>.`));
}

const idList = (ids: string[]) => ids.map((id) => `\`${id}\``).join(", ");

/**
 * `/bh-owner simulate-biome network_relays:<guild ids>` - relays the simulated find to ONLY those
 * Network servers, as a test (see `scheduleSimulatedNetworkPost`). Returns the line added to the reply.
 */
export async function relaySimulationToNetwork(
    ctx: CommandContext,
    guild: Guild,
    finderDiscordId: string,
    biome: string,
    eventId: number | null,
    now: Date,
    relayGuildIds: string[],
): Promise<string> {
    const result = await scheduleSimulatedNetworkPost(
        {
            originGuildId: guild.id,
            originName: guild.name,
            originIconUrl: guild.iconURL(),
            finderDiscordId,
            eventId,
            biome,
            serverLink: null,
            now,
        },
        relayGuildIds,
        defaultNetworkPublishDeps(ctx.client),
    );
    if (result.kind === "skipped") return `\nNetwork relay not sent: ${result.reason}.`;
    const ignored =
        result.ignored.length > 0 ? `\nIgnored (not a Network member with a channel, or this server): ${idList(result.ignored)}` : "";
    return `\nNetwork relay \`${result.postId}\` scheduled to ${idList(result.targets)} - a TEST post (no ping, no vote) after the local post + home advantage.${ignored}`;
}

const WEEK_MS = 7 * 86_400_000;

/** `/bh-owner network overview` - a summary page, then every member and pending server, paginated. */
async function runOverview(ctx: CommandContext): Promise<void> {
    const [guilds, stats] = await Promise.all([getActiveNetworkGuilds(), getNetworkStats(new Date(Date.now() - WEEK_MS))]);
    const toServer = (row: NetworkGuildRow): OverviewServer => {
        const cached = ctx.client.guilds.cache.get(row.guild_id);
        return {
            guildId: row.guild_id,
            name: cached?.name ?? "unknown",
            inviteUrl: row.invite_url,
            forced: row.forced,
            hasChannel: Boolean(row.network_channel_id),
            botInGuild: Boolean(cached),
        };
    };
    const pages = buildNetworkOverviewPages({
        members: guilds.filter((g) => g.status === NetworkStatus.MEMBER).map(toServer),
        pending: guilds.filter((g) => g.status === NetworkStatus.PENDING).map(toServer),
        stats: {
            posts7d: stats.posts,
            fakeVerdicts7d: stats.fakes,
            multiMacro7d: stats.multi,
            queuedPosts: stats.queued,
            openVotes: stats.open_votes,
            bannedGuilds: stats.banned_guilds,
            bannedUsers: stats.banned_users,
        },
    });
    await ctx.open(paginate({ name: "biomehunt.net-overview", pages: pages.length, renderPage: (i) => v2(pages[i]) }), undefined);
}
