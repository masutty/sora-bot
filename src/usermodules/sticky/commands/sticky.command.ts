import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { confirm, defineCommand, type GuildCommandContext, UserFacingError } from "@/define";
import { CommandCategory } from "@/types";
import { EmbedFormatter, NO_PINGS } from "@/utils/format";
import { accessMessage, type ChannelAccess, channelAccess } from "../services/channel-access";
import { stickyRuntime } from "../services/runtime";
import { type StickyService, savedLine } from "../services/sticky.service";
import { DELAY_HINT, delayLabel, modeLabel, parseDelay, settings } from "../settings";
import { StickyError, type StickyMode } from "../types";
import { captureView } from "../views/capture.view";
import { listText } from "../views/panel.screens";
import { type PanelChannel, stickyPanelView } from "../views/panel.view";

const RED = 0xda373c;

/** What the command needs that would otherwise be a Discord or database call, injected so its tests never hit either. */
export interface StickyCommandDeps {
    service: StickyService;
    access(channelId: string): ChannelAccess;
    channels?(): PanelChannel[];
}

export function defaultStickyDeps(ctx: GuildCommandContext): StickyCommandDeps {
    return {
        service: stickyRuntime(ctx.client).service,
        access(channelId) {
            const channel = ctx.guild.channels.cache.get(channelId);
            const me = ctx.guild.members.me;
            if (!channel || !me) return "not_text";
            return channelAccess(channel, ctx.member, me);
        },
        channels: () =>
            [...ctx.guild.channels.cache.values()]
                .filter((ch) => ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement)
                .map((ch) => ({ id: ch.id, name: ch.name, position: "rawPosition" in ch ? ch.rawPosition : 0 })),
    };
}

export function buildStickyOptions() {
    return new SlashCommandBuilder()
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
        .addSubcommand((s) =>
            s
                .setName("create")
                .setDescription("Create the sticky for this channel.")
                .addStringOption((o) =>
                    o
                        .setName("mode")
                        .setDescription("Which messages move the sticky")
                        .addChoices(...settings.modes.map((mode) => ({ name: modeLabel(mode), value: mode }))),
                )
                .addStringOption((o) =>
                    o
                        .setName("delay")
                        .setDescription("Minimum time between reposts")
                        .addChoices(...settings.delaysSeconds.map((sec) => ({ name: delayLabel(sec), value: String(sec) }))),
                ),
        )
        .addSubcommand((s) => s.setName("edit").setDescription("Replace the sticky text of this channel."))
        .addSubcommand((s) => s.setName("delete").setDescription("Delete the sticky of this channel."))
        .addSubcommand((s) => s.setName("list").setDescription("List the stickies of this server."))
        .addSubcommand((s) => s.setName("panel").setDescription("Open the sticky panel."));
}

function currentChannelId(ctx: GuildCommandContext): string {
    return ctx.raw.kind === "slash" ? (ctx.raw.interaction.channelId ?? "") : ctx.raw.message.channelId;
}

function requireAccess(deps: StickyCommandDeps, channelId: string): void {
    const access = deps.access(channelId);
    if (access !== "ok") throw new UserFacingError(accessMessage[access](channelId));
}

function requireSticky(deps: StickyCommandDeps, channelId: string): void {
    if (!deps.service.get(channelId)) throw new StickyError("This channel has no sticky.");
}

function parseMode(raw: string | null): StickyMode | undefined {
    if (raw === null) return undefined;
    if (!(settings.modes as readonly string[]).includes(raw))
        throw new UserFacingError(`Mode must be one of: ${settings.modes.join(", ")}.`);
    return raw as StickyMode;
}

function parseDelayArg(raw: string | null): number | undefined {
    if (raw === null) return undefined;
    const seconds = parseDelay(raw);
    if (seconds === undefined) throw new UserFacingError(`Delay must be one of: ${DELAY_HINT}.`);
    return seconds;
}

export async function runSticky(ctx: GuildCommandContext, deps: StickyCommandDeps): Promise<void> {
    const { service } = deps;
    const sub = ctx.args.getSubcommand() ?? "panel";
    const channelId = currentChannelId(ctx);

    switch (sub) {
        case "create": {
            const mode = parseMode(ctx.args.getString("mode"));
            const delaySeconds = parseDelayArg(ctx.args.getString("delay"));
            requireAccess(deps, channelId);
            if (service.get(channelId)) throw new StickyError("This channel already has a sticky. Use `/sticky edit`.");
            const { used, limit } = await service.overview(ctx.guild.id);
            if (used >= limit) throw new StickyError(`This server is at its sticky limit (${used}/${limit}).`);
            await ctx.open(
                captureView({
                    title: `Send the sticky for <#${channelId}>.`,
                    save: async (content) => {
                        const out = await service.create({
                            guildId: ctx.guild.id,
                            channelId,
                            content,
                            mode,
                            delaySeconds,
                            userId: ctx.user.id,
                        });
                        return savedLine(out, `Sticky created in <#${channelId}>.`);
                    },
                }),
                undefined,
            );
            return;
        }
        case "edit": {
            requireSticky(deps, channelId);
            requireAccess(deps, channelId);
            await ctx.open(
                captureView({
                    title: `Send the new sticky for <#${channelId}>.`,
                    save: async (content) => {
                        return savedLine(await service.editContent(channelId, content), `Sticky updated in <#${channelId}>.`);
                    },
                }),
                undefined,
            );
            return;
        }
        case "delete": {
            requireSticky(deps, channelId);
            if (deps.access(channelId) === "user_cannot_manage") throw new UserFacingError(accessMessage.user_cannot_manage(channelId));
            await ctx.open(
                confirm({
                    name: "sticky.delete",
                    title: "Delete this sticky?",
                    body: `<#${channelId}>`,
                    color: RED,
                    confirmLabel: "Delete",
                    onConfirm: async () => {
                        await service.remove(channelId);
                        return EmbedFormatter.success(`Sticky deleted from <#${channelId}>.`);
                    },
                }),
                undefined,
            );
            return;
        }
        case "list": {
            await ctx.defer({ ephemeral: true });
            await ctx.reply({ content: listText(await service.overview(ctx.guild.id)), allowedMentions: NO_PINGS });
            return;
        }
        default: {
            await ctx.open(
                stickyPanelView({
                    guildId: ctx.guild.id,
                    userId: ctx.user.id,
                    service,
                    access: deps.access,
                    channels: deps.channels,
                }),
                undefined,
            );
        }
    }
}

export default defineCommand({
    name: "sticky",
    description: "Keep a message at the bottom of a channel.",
    category: CommandCategory.ADMIN,
    showOnHelp: true,
    guildOnly: true,
    permissions: [PermissionFlagsBits.ManageMessages],
    onMissingSubcommand: "run",
    options: buildStickyOptions(),

    async run(ctx) {
        await runSticky(ctx, defaultStickyDeps(ctx));
    },
});
