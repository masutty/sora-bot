import type { Guild } from "discord.js";
import { type ContainerBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { type CommandArgs, defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import { parseDuration } from "@/utils/duration";
import { EmbedFormatter, type FormattedReply, NO_PINGS } from "@/utils/format";
import { getBadgeMeta, getRoleBadges, resolveBadgeSlug } from "../constants/badges.constants";
import { MAX_DISCORD_CHOICES } from "../constants/biomes.constants";
import { runEzSetupFlow } from "../flows/ez-setup.flow";
import { getGuildFlags } from "../repository/flags.repository";
import { listBadges, setBadges } from "../services/badge.service";
import { defaultPauseDeps, forcePause, unpauseByAdmin } from "../services/pause.service";
import { type Badge, BiomeHuntError } from "../types";
import { defaultFlagsDeps, flagsView } from "../views/flags.view";
import { defaultForwardsDeps, forwardsView } from "../views/forwards.view";
import { openMemberAdmin, resolveTargetMember } from "../views/member-admin.open";
import { defaultQuotasDeps, loadQuotasInput, quotasView } from "../views/quotas.view";
import { defaultSettingsDeps, loadSettingsInput, settingsView } from "../views/settings.view";
import { shopAdminView } from "../views/shop-admin.view";
import { checkVoteChoices, openReviewQueue, openVoteReview } from "../views/vote-review.open";

/**
 * Autocomplete for the `badge` option of `badges set` - only the badges a role can be
 * attached to. Value is the badge's slug (easy to type in prefix mode), resolved back via `resolveBadgeSlug`.
 */
function badgeAutocompleteChoices(typed: string): Array<{ name: string; value: string }> {
    const badges = getRoleBadges();
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

type PauseInput = Parameters<typeof forcePause>[1];

/** Lowercases and turns `_`/`-` into spaces so `session_end`, `Session-End` and `session end` all match. */
function normalizeChoice(raw: string): string {
    return raw.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

/** Maps the `/admin pause` options (slash or prefix) to the `forcePause` input. Pure: no Discord calls. */
const UNTIL_PRESETS = [
    { name: "Until they respond", value: "interaction" },
    { name: "Until their session ends", value: "session end" },
    { name: "1 hour", value: "1h" },
    { name: "6 hours", value: "6h" },
    { name: "1 day", value: "1d" },
    { name: "3 days", value: "3d" },
];

/** What `until` suggests: the presets matching what was typed, after the typed time itself when it is one. */
export function untilChoices(typed: string): Array<{ name: string; value: string }> {
    const text = typed.trim().toLowerCase();
    const matching = UNTIL_PRESETS.filter((p) => p.name.toLowerCase().includes(text) || p.value.includes(text));
    const isPreset = UNTIL_PRESETS.some((p) => p.value === text);
    return text && !isPreset && parseDuration(text, "h") !== null ? [{ name: `For ${text}`, value: text }, ...matching] : matching;
}

export function parsePauseOptions(
    args: Pick<CommandArgs, "getString" | "getBoolean">,
    target: { guildId: string; discordUserId: string; byDiscordId: string },
): PauseInput {
    const message = args.getString("message")?.trim();
    if (!message) throw new BiomeHuntError("Missing required argument: message");
    if (message.length > 1000) throw new BiomeHuntError("The message can have at most 1000 characters.");

    const notifyRaw = normalizeChoice(args.getString("notify") ?? "now");
    if (notifyRaw !== "now" && notifyRaw !== "session end") throw new BiomeHuntError("`notify` must be `now` or `session end`.");

    const untilRaw0 = (args.getString("until") ?? "interaction").trim();
    const untilRaw = normalizeChoice(untilRaw0);
    let until: PauseInput["until"];
    if (untilRaw === "interaction") until = { kind: "interaction" };
    else if (untilRaw === "session" || untilRaw === "session end") until = { kind: "session_end" };
    else until = { kind: "time", duration: untilRaw0 };

    return {
        ...target,
        message,
        count: !(args.getBoolean("invalidate_sessions_while_paused") ?? true),
        dismissable: args.getBoolean("dismissable") ?? true,
        notify: notifyRaw === "now" ? "now" : "session_end",
        until,
    };
}

export default defineCommand({
    name: "admin",
    description: "Biome hunting admin commands.",
    category: CommandCategory.ADMIN,
    showOnHelp: true,
    adminOnly: true,
    guildOnly: true,
    onMissingSubcommand: "run",
    prefixNamedOnly: ["pause:invalidate_sessions_while_paused", "pause:notify", "pause:until", "pause:dismissable"],

    options: new SlashCommandBuilder()
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand((s) => s.setName("setup").setDescription("Guided step-by-step setup wizard."))
        .addSubcommand((s) => s.setName("flags").setDescription("Turn optional features on or off for this server."))
        .addSubcommand((s) => s.setName("quotas").setDescription("Quota reward roles members earn by macroing."))
        .addSubcommand((s) => s.setName("shop").setDescription("Sell roles and items for Seeds."))
        .addSubcommand((s) => s.setName("forwarding").setDescription("Where biome finds get posted, right away and after a delay."))
        .addSubcommand((s) =>
            s.setName("settings").setDescription("Activity, status roles, macro channels, auto-delete and the live counter."),
        )
        .addSubcommand((s) =>
            s
                .setName("check-vote")
                .setDescription("Review recent votes, or see who voted on a rare find and mark it real or fake.")
                .addStringOption((o) =>
                    o.setName("id").setDescription("A recent rare find, or the Vote id on its post").setAutocomplete(true),
                ),
        )
        .addSubcommandGroup((g) =>
            g
                .setName("badges")
                .setDescription("Manage badges (biome-discovery and bot-triggered).")
                .addSubcommand((s) =>
                    s
                        .setName("set")
                        .setDescription("Configure the role a badge grants. Leave role empty to unconfigure it.")
                        .addStringOption((o) => o.setName("badge").setDescription("Badge").setRequired(true).setAutocomplete(true))
                        .addRoleOption((o) => o.setName("role").setDescription("Role to grant (leave empty to unconfigure)")),
                )
                .addSubcommand((s) => s.setName("list").setDescription("List all badges and their current role configuration.")),
        )
        .addSubcommand((s) =>
            s
                .setName("pause")
                .setDescription("Pause a member and tell them in their Macro Channel.")
                .addUserOption((o) => o.setName("user").setDescription("Member to pause").setRequired(true))
                .addStringOption((o) => o.setName("message").setDescription("What the member is told").setRequired(true).setMaxLength(1000))
                .addBooleanOption((o) =>
                    o.setName("invalidate_sessions_while_paused").setDescription("Nothing they do counts while paused (default: yes)"),
                )
                .addStringOption((o) =>
                    o
                        .setName("notify")
                        .setDescription("When the member is told (default: now)")
                        .addChoices({ name: "now", value: "now" }, { name: "session end", value: "session end" }),
                )
                .addStringOption((o) =>
                    o
                        .setName("until")
                        .setDescription("When it ends: pick one, or type a time like 12h (default: they respond)")
                        .setAutocomplete(true),
                )
                .addBooleanOption((o) => o.setName("dismissable").setDescription("Let them dismiss the message (default: yes)")),
        )
        .addSubcommand((s) =>
            s
                .setName("unpause")
                .setDescription("End a member's pause.")
                .addUserOption((o) => o.setName("user").setDescription("Member to unpause").setRequired(true)),
        )
        .addSubcommand((s) =>
            s
                .setName("member")
                .setDescription("Manage one member: profile, biomes, badges, sessions, channel.")
                .addUserOption((o) => o.setName("user").setDescription("Target user").setRequired(true)),
        ),

    async executeAutocomplete(interaction) {
        const focused = interaction.options.getFocused(true);
        if (focused.name === "id" && interaction.guild)
            return interaction.respond(await checkVoteChoices(interaction.guild, focused.value));
        if (focused.name === "until") return interaction.respond(untilChoices(focused.value));
        if (focused.name !== "badge") return interaction.respond([]);
        await interaction.respond(badgeAutocompleteChoices(focused.value));
    },

    async run(ctx) {
        const group = ctx.args.getSubcommandGroup();
        const sub = ctx.args.getSubcommand();

        // onMissingSubcommand: "run" - a missing/unknown subcommand gets the framework's usage.
        if (!sub) {
            await ctx.replyUsage();
            return;
        }
        const routeKey = group ? `${group}-${sub}` : sub;

        if (routeKey === "member") {
            await openMemberAdmin(ctx, ctx.guild, await resolveTargetMember(ctx.args));
            return;
        }

        if (routeKey === "check-vote") {
            const id = ctx.args.getString("id")?.trim();
            if (id) await openVoteReview(ctx, ctx.guild, id);
            else await openReviewQueue(ctx, ctx.guild);
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

        if (routeKey === "forwarding") {
            await ctx.defer();
            await ctx.open(forwardsView(defaultForwardsDeps(ctx.client, ctx.guild)), undefined);
            return;
        }

        if (routeKey === "shop") {
            await ctx.defer();
            // Lazy: the real repositories load only when the shop menu opens.
            const { defaultShopAdminDeps } = await import("../services/shop-admin-deps.service");
            await ctx.open(shopAdminView(defaultShopAdminDeps(ctx.client, ctx.guild)), undefined);
            return;
        }

        if (routeKey === "setup") {
            await ctx.defer();
            await runEzSetupFlow(ctx, ctx.guild.id);
            return;
        }

        await ctx.defer();
        await ctx.reply(toReplyPayload(await runSubcommand(routeKey, ctx.guild, ctx.client, ctx.args, ctx.user.id)));
    },
});

/** Resolves an option's id, e.g. `await idOf(args.getChannel("channel"))` -> `"123"` or `null`. */
async function idOf(entity: Promise<{ id: string } | null>): Promise<string | null> {
    return (await entity)?.id ?? null;
}

async function runSubcommand(
    sub: string,
    guild: Guild,
    client: BotClient,
    args: CommandArgs,
    invokerId: string,
): Promise<string | ContainerBuilder> {
    const guildId = guild.id;

    switch (sub) {
        case "badges-set": {
            const badge = requireBadge(args.getString("badge"));
            const roleId = await idOf(args.getRole("role"));
            return setBadges(guildId, badge, roleId);
        }
        case "badges-list":
            return listBadges(guildId);
        case "pause": {
            const user = await args.getUser("user");
            if (!user) throw new BiomeHuntError("Missing required argument: user");
            const input = parsePauseOptions(args, { guildId, discordUserId: user.id, byDiscordId: invokerId });
            return forcePause(defaultPauseDeps(client), input);
        }
        case "unpause": {
            const user = await args.getUser("user");
            if (!user) throw new BiomeHuntError("Missing required argument: user");
            return unpauseByAdmin(guildId, user.id);
        }
        default:
            throw new BiomeHuntError(`Unknown subcommand: ${sub}`);
    }
}

/** Admin/config results routinely echo a role back (`"The role is now <@&...>"`) - `NO_PINGS`
 * keeps the mention visible without actually pinging the role just because it showed up on a report. */
function toReplyPayload(result: string | ContainerBuilder): FormattedReply {
    if (typeof result === "string") return { ...EmbedFormatter.success(result), allowedMentions: NO_PINGS };
    return { flags: MessageFlags.IsComponentsV2, components: [result], allowedMentions: NO_PINGS };
}
