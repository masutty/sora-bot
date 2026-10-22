import type { MessageCreateOptions } from "discord.js";
import { ChannelType, SlashCommandBuilder } from "discord.js";
import { defineCommand, type GuildCommandContext } from "@/define";
import { CommandCategory } from "@/types";
import { EmbedFormatter, type FormattedReply, NO_PINGS } from "@/utils/format";
import { parseBadgeInput } from "../services/badge-input";
import { formatHexColor, parseHexColor } from "../services/color";
import { type SendResult, sendPost } from "../services/poller.service";
import { canMention, type PostStatus, postStatus } from "../services/post-status";
import { defaultTrackerConfig, type TrackerConfig } from "../services/tracker-config.service";
import { BadgeTrackerError } from "../types";
import { buildTestPost } from "../views/award-post";
import { defaultTrackerViewDeps, renderOverviewReadOnly, trackerSettingsView } from "../views/settings.view";

/** What the command needs that would otherwise be a DB/Discord call, injected so its tests never hit any of them. */
export interface BadgeTrackerDeps {
    config: TrackerConfig;
    postStatus(channelId: string | null): PostStatus;
    canMention(roleId: string): boolean;
    send(channelId: string, payload: MessageCreateOptions): Promise<SendResult>;
}

export function defaultBadgeTrackerDeps(ctx: GuildCommandContext): BadgeTrackerDeps {
    return {
        config: defaultTrackerConfig(),
        postStatus: (channelId) => postStatus(ctx.client, ctx.guild.id, channelId),
        canMention: (roleId) => canMention(ctx.guild, roleId),
        send: (channelId, payload) => sendPost(ctx.client, channelId, payload),
    };
}

export function buildBadgeTrackerOptions() {
    return new SlashCommandBuilder()
        .addSubcommand((s) => s.setName("settings").setDescription("Open the badge tracker settings."))
        .addSubcommand((s) =>
            s
                .setName("add")
                .setDescription("Track a Roblox badge.")
                .addStringOption((o) => o.setName("id").setDescription("Badge ID or roblox.com/badges link").setRequired(true))
                .addRoleOption((o) => o.setName("role").setDescription("Role to ping when someone earns it")),
        )
        .addSubcommand((s) =>
            s
                .setName("remove")
                .setDescription("Stop tracking a badge.")
                .addStringOption((o) => o.setName("id").setDescription("Badge ID or roblox.com/badges link").setRequired(true)),
        )
        .addSubcommand((s) => s.setName("list").setDescription("List the tracked badges."))
        .addSubcommand((s) =>
            s
                .setName("channel")
                .setDescription("Set the channel that gets badge updates.")
                .addChannelOption((o) =>
                    o
                        .setName("channel")
                        .setDescription("Channel for badge updates")
                        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                        .setRequired(true),
                ),
        )
        .addSubcommand((s) =>
            s
                .setName("role")
                .setDescription("Set or clear the role pinged for a badge.")
                .addStringOption((o) => o.setName("id").setDescription("Badge ID or roblox.com/badges link").setRequired(true))
                .addRoleOption((o) => o.setName("role").setDescription("Role to ping (leave empty to clear)")),
        )
        .addSubcommand((s) =>
            s
                .setName("description")
                .setDescription("Set or reset the description shown for a badge.")
                .addStringOption((o) => o.setName("id").setDescription("Badge ID or roblox.com/badges link").setRequired(true))
                .addStringOption((o) =>
                    o.setName("text").setDescription("Custom description (leave empty to use the Roblox one)").setMaxLength(300),
                ),
        )
        .addSubcommand((s) =>
            s
                .setName("color")
                .setDescription("Set or reset the card color for a badge.")
                .addStringOption((o) => o.setName("id").setDescription("Badge ID or roblox.com/badges link").setRequired(true))
                .addStringOption((o) =>
                    o.setName("hex").setDescription("Hex color like #7CF5FF (leave empty for the default)").setMaxLength(7),
                ),
        )
        .addSubcommand((s) =>
            s
                .setName("test")
                .setDescription("Post a test card for each tracked badge, without pings.")
                .addStringOption((o) => o.setName("id").setDescription("Only this badge (ID or roblox.com/badges link)")),
        )
        .addSubcommand((s) =>
            s
                .setName("interval")
                .setDescription("Set how often badges are checked.")
                .addIntegerOption((o) =>
                    o.setName("minutes").setDescription("Minutes between checks (1-60)").setMinValue(1).setMaxValue(60).setRequired(true),
                ),
        );
}

/** A reply that can never ping anyone, even when its text holds a role or channel mention. */
function quietSuccess(text: string): FormattedReply {
    return { ...EmbedFormatter.success(text), allowedMentions: NO_PINGS };
}

function cannotPing(roleId: string): FormattedReply {
    return {
        ...EmbedFormatter.error(`I can't ping <@&${roleId}>. Make it mentionable or give me the Mention Everyone permission.`),
        allowedMentions: NO_PINGS,
    };
}

/** `/badgetracker test`: one test card per badge (or just `rawId`), sent one at a time, never pinging. */
async function sendTests(guildId: string, rawId: string | null, deps: BadgeTrackerDeps): Promise<FormattedReply> {
    const overview = await deps.config.getOverview(guildId);
    const { channelId } = overview;
    if (!channelId) throw new BadgeTrackerError("Pick a channel first with `/badgetracker channel`.");
    if (deps.postStatus(channelId) !== "ok") {
        throw new BadgeTrackerError(`I can't post in <#${channelId}>. Give me permission to send messages there first.`);
    }

    let rows = overview.badges.filter((b) => !b.deleted);
    if (rawId !== null) {
        const id = parseBadgeInput(rawId);
        if (id === null) throw new BadgeTrackerError("That isn't a badge ID or a roblox.com/badges link.");
        const row = overview.badges.find((b) => b.badge_id === id);
        if (!row) throw new BadgeTrackerError(`This server doesn't track a badge with ID \`${id}\`.`);
        if (row.deleted) throw new BadgeTrackerError(`**${row.name}** was deleted on Roblox, so there's nothing to test.`);
        rows = [row];
    }
    if (rows.length === 0) throw new BadgeTrackerError("There are no badges to test. Add one first.");

    let sent = 0;
    for (const row of rows) {
        if ((await deps.send(channelId, buildTestPost(row, overview.intervalMinutes))) !== "sent") break;
        sent++;
    }
    if (sent < rows.length) {
        return quietSuccess(`Sent ${sent} of ${rows.length} test posts to <#${channelId}>. I couldn't send the rest.`);
    }
    return quietSuccess(
        rows.length === 1 ? `Sent a test post for **${rows[0]?.name}** to <#${channelId}>.` : `Sent ${sent} test posts to <#${channelId}>.`,
    );
}

export async function runBadgeTracker(ctx: GuildCommandContext, deps: BadgeTrackerDeps): Promise<void> {
    const { config } = deps;
    const guildId = ctx.guild.id;
    const sub = ctx.args.getSubcommand();

    if (sub === "settings") {
        await ctx.defer();
        await ctx.open(trackerSettingsView(defaultTrackerViewDeps(ctx.client, ctx.guild)), undefined);
        return;
    }

    await ctx.defer({ ephemeral: true });

    switch (sub) {
        case "add": {
            const role = await ctx.args.getRole("role");
            if (role && !deps.canMention(role.id)) {
                await ctx.reply(cannotPing(role.id));
                return;
            }
            const preview = await config.previewBadge(guildId, ctx.args.getString("id", true));
            await config.trackBadge(guildId, preview, role?.id ?? null);
            await ctx.reply(quietSuccess(`Now tracking **${preview.badge.name}**.`));
            return;
        }
        case "remove": {
            const name = await config.removeBadge(guildId, ctx.args.getString("id", true));
            await ctx.reply(quietSuccess(`Stopped tracking **${name}**.`));
            return;
        }
        case "list": {
            const overview = await config.getOverview(guildId);
            await ctx.reply({
                ...renderOverviewReadOnly(overview, deps.postStatus(overview.channelId)),
                allowedMentions: NO_PINGS,
            });
            return;
        }
        case "channel": {
            const channel = await ctx.args.getChannel("channel");
            if (!channel) return;
            await config.setChannel(guildId, channel.id);
            let text = `Updates go to <#${channel.id}>.`;
            if (deps.postStatus(channel.id) !== "ok") {
                text += `\n⚠️ I can't post in <#${channel.id}>. Updates are paused until I can send messages there.`;
            }
            await ctx.reply(quietSuccess(text));
            return;
        }
        case "role": {
            const role = await ctx.args.getRole("role");
            if (role && !deps.canMention(role.id)) {
                await ctx.reply(cannotPing(role.id));
                return;
            }
            const name = await config.setPingRole(guildId, ctx.args.getString("id", true), role?.id ?? null);
            await ctx.reply(quietSuccess(role ? `${name} pings <@&${role.id}>.` : `${name} has no ping.`));
            return;
        }
        case "description": {
            const text = ctx.args.getString("text");
            const name = await config.setDescription(guildId, ctx.args.getString("id", true), text);
            await ctx.reply(
                quietSuccess(text === null ? `${name} uses the Roblox description again.` : `Description for ${name} updated.`),
            );
            return;
        }
        case "color": {
            const hex = ctx.args.getString("hex");
            const name = await config.setColor(guildId, ctx.args.getString("id", true), hex);
            // setColor already refused a bad hex, so this only tells "set" from "reset".
            const color = hex?.trim() ? parseHexColor(hex) : null;
            await ctx.reply(quietSuccess(color === null ? `${name} uses the default color.` : `${name} uses ${formatHexColor(color)}.`));
            return;
        }
        case "test": {
            await ctx.reply(await sendTests(guildId, ctx.args.getString("id"), deps));
            return;
        }
        case "interval": {
            const minutes = ctx.args.getInteger("minutes", true);
            await config.setIntervalMinutes(minutes);
            await ctx.reply(quietSuccess(`Badges are checked every ${minutes} minutes.`));
            return;
        }
    }
}

export default defineCommand({
    name: "badgetracker",
    description: "Track Roblox badges and post when someone earns them.",
    category: CommandCategory.ADMIN,
    botOwnerOnly: true,
    guildOnly: true,
    options: buildBadgeTrackerOptions(),

    async run(ctx) {
        await runBadgeTracker(ctx, defaultBadgeTrackerDeps(ctx));
    },
});
