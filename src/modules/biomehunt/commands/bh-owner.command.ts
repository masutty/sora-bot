import { SlashCommandBuilder } from "discord.js";
import { transaction } from "@/database/connection";
import type { BotClient } from "@/core/bot-client";
import { type CommandContext, confirm, defineCommand, UserFacingError } from "@/define";
import { CommandCategory } from "@/types";
import { EmbedFormatter, type FormattedReply, NO_PINGS } from "@/utils/format";
import { Logger } from "@/utils/logging";
import { newTraceRef } from "@/utils/trace";
import {
    ALL_BIOME_CATEGORIES, BIOME_CATEGORY_LABELS, BIOME_META, BIOME_ONLY_CHOICES, formatBiomeName, getBiomesByCategory,
} from "../constants/biomes.constants";
import { FLOWER_META } from "../constants/flowers.constants";
import { insertEventIfNew } from "../repository/activity.repository";
import { getForwardConfig } from "../repository/forwards.repository";
import { isFlagEnabled } from "../repository/flags.repository";
import { deleteGuildData, getAllGuildIds, getGuildDataSummary, type StaleGuildSummary } from "../repository/guilds.repository";
import { getUserByDiscordId, getUsersByDiscordId } from "../repository/users.repository";
import { applyUserRewardBackfill, planUserRewardBackfill } from "../services/biome-reward.service";
import { forwardBiome } from "../services/forward.service";
import { rerollFlower } from "../services/flower.service";
import { type BiomeCategory, BiomeHuntError, type ParsedEvent } from "../types";

const logger = new Logger("biomehunt.commands.bh-owner");

const BIOME_CATEGORY_CHOICES = ALL_BIOME_CATEGORIES.map((c) => ({ name: BIOME_CATEGORY_LABELS[c], value: c }));
const RARE_BIOME_CHOICES = getBiomesByCategory("rare").map((b) => ({ name: formatBiomeName(b), value: b }));

/** Guilds with BiomeHunt data (bh_guilds) the bot is no longer a member of. */
async function findStaleGuilds(client: BotClient): Promise<StaleGuildSummary[]> {
    const allGuildIds = await getAllGuildIds();
    const staleIds = allGuildIds.filter((id) => !client.guilds.cache.has(id));
    return getGuildDataSummary(staleIds);
}

function formatGuildList(guilds: StaleGuildSummary[]): string {
    return guilds
        .map((g) => `- \`${g.guild_id}\` - ${g.user_count} user(s), ${g.macro_channel_count} macro channel(s)`)
        .join("\n");
}

export default defineCommand({
    name: "bh-owner",
    description: "Bot-owner housekeeping for BiomeHunt data across all guilds.",
    category: CommandCategory.ADMIN,
    botOwnerOnly: true,
    showOnHelp: false,

    options: new SlashCommandBuilder()
        .addSubcommand((s) =>
            s.setName("stale").setDescription("Lists guilds with BiomeHunt data the bot is no longer a member of."),
        )
        .addSubcommand((s) =>
            s
                .setName("stale-cleanup")
                .setDescription("Deletes a guild's BiomeHunt data - all stale guilds if none is given.")
                .addStringOption((o) =>
                    o.setName("guild_id").setDescription("Specific guild ID to clean up (omit for all stale guilds)").setRequired(false),
                ),
        )
        .addSubcommand((s) =>
            s
                .setName("recalculate-user")
                .setDescription("Backfills Seeds/XP for a user's confirmed biome finds that don't have a reward yet.")
                .addStringOption((o) => o.setName("guild_id").setDescription("Guild ID the user's profile is in").setRequired(true))
                .addStringOption((o) => o.setName("discord_user_id").setDescription("Target user's Discord ID").setRequired(true))
                .addStringOption((o) => o.setName("after_date").setDescription("Only events on/after this date (YYYY-MM-DD)"))
                .addStringOption((o) => o.setName("biome").setDescription("Only this specific biome").addChoices(...BIOME_ONLY_CHOICES))
                .addStringOption((o) => o.setName("category").setDescription("Only this biome category (ignored if biome is given)").addChoices(...BIOME_CATEGORY_CHOICES)),
        )
        .addSubcommand((s) =>
            s
                .setName("reroll-flower")
                .setDescription("Rerolls a user's Flower - the only admin-side way to change one once set.")
                .addStringOption((o) => o.setName("discord_user_id").setDescription("Target user's Discord ID").setRequired(true))
                .addStringOption((o) =>
                    o.setName("guild_id").setDescription("Guild ID - only needed if the user has a profile in more than one guild").setRequired(false),
                ),
        )
        // See `runSimulateRare`'s TSDoc: this inserts a REAL event, not a dry run - it counts in
        // stats and can grant real rewards through the normal vote/review flow.
        .addSubcommand((s) =>
            s
                .setName("simulate-rare")
                .setDescription("TESTING: fakes a rare-biome find so the owner can test the community-vote flow end to end.")
                .addStringOption((o) => o.setName("biome").setDescription("Rare biome to simulate (default Glitched)").addChoices(...RARE_BIOME_CHOICES))
                .addUserOption((o) => o.setName("user").setDescription("Target user (default: you)")),
        ),

    async run(ctx) {
        const sub = ctx.args.getSubcommand();
        await ctx.defer({ ephemeral: true });
        const reply = (payload: FormattedReply) => ctx.reply(payload);

        if (sub === "stale") {
            await ctx.reply(await renderStaleList(ctx.client));
            return;
        }

        if (sub === "recalculate-user") {
            await runRecalculateUser(ctx, {
                guildId: ctx.args.getString("guild_id", true),
                discordUserId: ctx.args.getString("discord_user_id", true),
                afterDateStr: ctx.args.getString("after_date"),
                biome: ctx.args.getString("biome"),
                category: ctx.args.getString("category") as BiomeCategory | null,
            });
            return;
        }

        if (sub === "reroll-flower") {
            await runOwnerRerollFlower(
                {
                    discordUserId: ctx.args.getString("discord_user_id", true),
                    guildId: ctx.args.getString("guild_id"),
                },
                ctx.client,
                reply,
            );
            return;
        }

        if (sub === "simulate-rare") {
            await runSimulateRare(ctx);
            return;
        }

        await runStaleCleanup(ctx, ctx.client, ctx.args.getString("guild_id"));
    },
});

interface RecalculateUserArgs {
    guildId: string;
    discordUserId: string;
    afterDateStr: string | null;
    biome: string | null;
    category: BiomeCategory | null;
}

/**
 * Additive-only backfill: grants Seeds/XP for a user's confirmed biome finds that don't already
 * have a `bh_biome_rewards` row (e.g. finds from before EXPERIMENT_BIOME_ECONOMY was turned on),
 * optionally narrowed by date and/or biome/category. Deliberately ignores that flag entirely - see
 * `planUserRewardBackfill`'s doc comment. Badges are out of scope; never touched here.
 */
async function runRecalculateUser(ctx: CommandContext, args: RecalculateUserArgs): Promise<void> {
    let afterDate: Date | null = null;
    if (args.afterDateStr) {
        afterDate = new Date(args.afterDateStr);
        if (isNaN(afterDate.getTime())) {
            await ctx.reply(EmbedFormatter.error("Invalid after_date - use YYYY-MM-DD."));
            return;
        }
    }

    const user = await getUserByDiscordId(args.guildId, args.discordUserId);
    if (!user) {
        await ctx.reply(EmbedFormatter.info(`<@${args.discordUserId}> has no profile in guild \`${args.guildId}\`.`));
        return;
    }

    const biomes = args.biome ? [args.biome] : args.category ? getBiomesByCategory(args.category) : null;

    const plan = await planUserRewardBackfill(user.id, { afterDate, biomes });
    if (plan.events.length === 0) {
        await ctx.reply(EmbedFormatter.info(`<@${args.discordUserId}> has no un-rewarded biome finds matching those filters.`));
        return;
    }

    const filterParts = [
        afterDate ? `since ${afterDate.toISOString().slice(0, 10)}` : null,
        args.biome ? formatBiomeName(args.biome) : args.category ? BIOME_CATEGORY_LABELS[args.category] : null,
    ].filter((p): p is string => p !== null);

    const { guildId, discordUserId } = args;

    // Titles echo `<@discordUserId>` - View payloads get NO_PINGS by default, so it shows without pinging.
    await ctx.open(
        confirm({
            name: "biomehunt.recalculate-user",
            title: `Backfill Seeds/XP for <@${discordUserId}> in guild \`${guildId}\`?`,
            fields: [
                { label: "Events to backfill", value: String(plan.events.length) },
                { label: "Seeds to grant", value: String(plan.totalSeeds) },
                { label: "XP to grant", value: String(plan.totalXp) },
                { label: "Filters", value: filterParts.length > 0 ? filterParts.join(", ") : "none" },
                ...(plan.skippedUnknownCount > 0 ? [{ label: "Skipped (unknown biome)", value: String(plan.skippedUnknownCount) }] : []),
            ],
            onConfirm: async () => {
                const updated = await applyUserRewardBackfill(user.id, plan);
                logger.info(`Backfilled ${plan.events.length} event(s) for user ${user.id} in guild ${guildId}: +${plan.totalSeeds} seeds, +${plan.totalXp} xp`);
                return EmbedFormatter.success(
                    `Backfilled ${plan.events.length} event(s) for <@${discordUserId}>: +${plan.totalSeeds} 🌱, +${plan.totalXp} XP.\n` +
                    `New balance: ${updated.seeds} 🌱, ${updated.xp} XP.`,
                );
            },
        }),
        undefined,
    );
}

interface RerollFlowerArgs {
    discordUserId: string;
    guildId: string | null;
}

/**
 * When `guild_id` is omitted, resolves it from the user's BiomeHunt profiles - only safe when they
 * have exactly one across every guild; ambiguous (or absent) otherwise, in which case the caller
 * must specify guild_id explicitly.
 */
async function resolveOwnerTargetGuild(discordUserId: string, guildId: string | null): Promise<{ guildId: string } | { error: string }> {
    if (guildId) return { guildId };

    const profiles = await getUsersByDiscordId(discordUserId);
    if (profiles.length === 0) return { error: `<@${discordUserId}> has no BiomeHunt profile in any guild.` };
    if (profiles.length > 1) {
        return {
            error: `<@${discordUserId}> has profiles in multiple guilds - specify guild_id: ${profiles.map((p) => `\`${p.guild_id}\``).join(", ")}.`,
        };
    }
    return { guildId: profiles[0].guild_id };
}

/**
 * Bot-owner-only Flower reroll - together with `/bh reroll`, the only two ways a user's Flower is
 * allowed to change once set (see `ensureFlower` in services/flower.service.ts, which reuses an existing Flower
 * rather than re-rolling it on setup/force-setup).
 */
async function runOwnerRerollFlower(
    args: RerollFlowerArgs,
    client: BotClient,
    replyPlain: (reply: FormattedReply) => Promise<unknown>,
): Promise<void> {
    const { discordUserId } = args;

    const resolved = await resolveOwnerTargetGuild(discordUserId, args.guildId);
    if ("error" in resolved) {
        await replyPlain(EmbedFormatter.error(resolved.error));
        return;
    }
    const { guildId } = resolved;

    if (!(await isFlagEnabled(guildId, "EXPERIMENT_WEBHOOK_FLOWERS"))) {
        await replyPlain(EmbedFormatter.error(`Flowers aren't enabled in guild \`${guildId}\`. Enable \`EXPERIMENT_WEBHOOK_FLOWERS\` there first.`));
        return;
    }

    const user = await getUserByDiscordId(guildId, discordUserId);
    if (!user) {
        await replyPlain(EmbedFormatter.error(`<@${discordUserId}> has no profile in guild \`${guildId}\`.`));
        return;
    }

    // A BiomeHuntError here (no macro channel, webhook gone) reaches the user through the framework.
    const { flower } = await rerollFlower(client, user.id);
    logger.info(`Rerolled Flower for user ${user.id} (guild ${guildId}): ${flower}`);
    await replyPlain(
        EmbedFormatter.success(`<@${discordUserId}>'s flower rerolled in guild \`${guildId}\`: **${FLOWER_META[flower].label}** (${FLOWER_META[flower].rarity}).`),
    );
}

/** Injectable for `resolveSimulateRareTarget`'s tests - no DB, no Discord. */
export interface SimulateRareDeps {
    getUserByDiscordId: typeof getUserByDiscordId;
    getForwardConfig: typeof getForwardConfig;
}

function defaultSimulateRareDeps(): SimulateRareDeps {
    return { getUserByDiscordId, getForwardConfig };
}

/**
 * Validates the preconditions for `/bh-owner simulate-rare`, split out from `runSimulateRare` so
 * its three error paths (non-rare biome, no profile, no forward configured) can be unit-tested
 * without a real Discord context or a database. The biome is checked first, and against
 * `BIOME_META` directly rather than trusting the slash option's `choices` - a prefix invocation
 * isn't restricted to them (see `command-args.ts`: "Prefix does NOT enforce ... choices").
 */
export async function resolveSimulateRareTarget(
    guildId: string,
    discordUserId: string,
    biome: string,
    deps: SimulateRareDeps = defaultSimulateRareDeps(),
): Promise<{ userId: number; forwardChannelId: string }> {
    if (BIOME_META[biome]?.category !== "rare") {
        throw new BiomeHuntError(`${formatBiomeName(biome)} is not a rare biome.`);
    }

    const user = await deps.getUserByDiscordId(guildId, discordUserId);
    if (!user) throw new BiomeHuntError(`<@${discordUserId}> has no profile in this server.`);

    const forward = await deps.getForwardConfig(guildId, biome);
    if (!forward) throw new BiomeHuntError(`No forward is configured for ${formatBiomeName(biome)} - set one with \`/bh-admin forward set\`.`);

    return { userId: user.id, forwardChannelId: forward.channel_id };
}

/**
 * TESTING ONLY - fakes a rare-biome find by inserting a REAL `bh_activity_events` row (same
 * repository insert `activity-ingest.service.ts` uses for a genuine macro message) and running it
 * through the exact same forward+vote pipeline (`forwardBiome`) as a real find. This is NOT a dry
 * run: the event counts in stats, a community "Real" vote or an admin `/bh-admin review` Confirm
 * grants the finder real Seeds/XP/badge rewards, and an admin Deny deletes the event - identical
 * consequences to an actual rare find. Meant for the bot owner to exercise the vote/close/reward/
 * review flow end to end without waiting for a real one to happen.
 */
async function runSimulateRare(ctx: CommandContext): Promise<void> {
    if (!ctx.guild) throw new UserFacingError("Run this in a server.");
    const guild = ctx.guild;

    const biome = ctx.args.getString("biome") ?? "GLITCHED";
    const targetUser = (await ctx.args.getUser("user")) ?? ctx.user;

    const { userId, forwardChannelId } = await resolveSimulateRareTarget(guild.id, targetUser.id, biome);

    const now = new Date();
    const messageId = `sim-${newTraceRef()}`;
    const eventId = await transaction((client) =>
        insertEventIfNew(client, userId, messageId, biome, "simulated", "started", now),
    );
    if (eventId === null) throw new BiomeHuntError("Failed to create the simulated event - try again.");

    const parsed: ParsedEvent = { biome, macroType: "simulated", eventType: "started", eventTimestamp: now, serverLink: null };
    const jumpLink =
        ctx.raw.kind === "prefix"
            ? `https://discord.com/channels/${guild.id}/${ctx.raw.message.channelId}/${ctx.raw.message.id}`
            : `https://discord.com/channels/${guild.id}/${ctx.raw.interaction.channelId}`;

    await forwardBiome(ctx.client, guild.id, userId, parsed, eventId, jumpLink);

    logger.info(`Simulated ${biome} for user ${userId} (guild ${guild.id}), event ${eventId}`);
    await ctx.reply({
        ...EmbedFormatter.success(`Simulated ${formatBiomeName(biome)} for <@${targetUser.id}> - vote opened in <#${forwardChannelId}>.`),
        allowedMentions: NO_PINGS,
    });
}

async function renderStaleList(client: BotClient): Promise<FormattedReply> {
    const stale = await findStaleGuilds(client);
    if (!stale.length) return EmbedFormatter.plain("No stale guilds - every guild with BiomeHunt data still has the bot in it.");
    return EmbedFormatter.plain(`**${stale.length} stale guild(s):**\n${formatGuildList(stale)}`);
}

/**
 * `guildId` given -> targets just that guild, whether it's stale or not (a general "wipe this
 * guild's BiomeHunt data" escape hatch). `guildId` omitted -> targets every stale guild at once,
 * with a SINGLE confirmation covering all of them - never one confirmation per guild.
 */
async function runStaleCleanup(ctx: CommandContext, client: BotClient, guildId: string | null): Promise<void> {
    const targets = guildId ? await getGuildDataSummary([guildId]) : await findStaleGuilds(client);

    if (!targets.length) {
        await ctx.reply(
            EmbedFormatter.info(guildId ? `Guild \`${guildId}\` has no BiomeHunt data.` : "No stale guilds to clean up."),
        );
        return;
    }

    const totalUsers = targets.reduce((sum, g) => sum + g.user_count, 0);
    const totalChannels = targets.reduce((sum, g) => sum + g.macro_channel_count, 0);

    await ctx.open(
        confirm({
            name: "biomehunt.stale-cleanup",
            title:
                targets.length === 1
                    ? `Delete all BiomeHunt data for guild \`${targets[0].guild_id}\`?`
                    : `Delete all BiomeHunt data for ${targets.length} stale guild(s)?`,
            fields: [
                { label: "Guilds", value: targets.map((g) => g.guild_id).join(", ") },
                { label: "Users tracked", value: String(totalUsers) },
                { label: "Macro channels", value: String(totalChannels) },
            ],
            color: 0xed4245,
            onConfirm: async () => {
                const guildIds = targets.map((g) => g.guild_id);
                const deleted = await deleteGuildData(guildIds);
                logger.info(`Deleted BiomeHunt data for ${deleted} guild(s): ${guildIds.join(", ")}`);
                return EmbedFormatter.success(`Deleted BiomeHunt data for ${deleted} guild(s).`);
            },
        }),
        undefined,
    );
}
