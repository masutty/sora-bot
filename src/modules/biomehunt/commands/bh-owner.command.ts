import { SlashCommandBuilder } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { transaction } from "@/database/connection";
import { type CommandContext, confirm, defineCommand, UserFacingError } from "@/define";
import { CommandCategory } from "@/types";
import { EmbedFormatter, type FormattedReply, NO_PINGS } from "@/utils/format";
import { Logger } from "@/utils/logging";
import { newTraceRef } from "@/utils/trace";
import {
    ALL_BIOME_CATEGORIES,
    BIOME_CATEGORY_LABELS,
    BIOME_META,
    BIOME_ONLY_CHOICES,
    formatBiomeName,
    getBiomesByCategory,
} from "../constants/biomes.constants";
import { FLOWER_META } from "../constants/flowers.constants";
import { insertEventIfNew } from "../repository/activity.repository";
import { isFlagEnabled } from "../repository/flags.repository";
import { getForwardConfig } from "../repository/forwards.repository";
import { deleteGuildData, getAllGuildIds, getGuildDataSummary, type StaleGuildSummary } from "../repository/guilds.repository";
import { getUserByDiscordId, getUsersByDiscordId } from "../repository/users.repository";
import { applyUserRewardBackfill, grantBiomeReward, planUserRewardBackfill } from "../services/biome-reward.service";
import { rerollFlower } from "../services/flower.service";
import { forwardBiome } from "../services/forward.service";
import { type BiomeCategory, BiomeHuntError, type ParsedEvent } from "../types";

const logger = new Logger("biomehunt.commands.bh-owner");

const BIOME_CATEGORY_CHOICES = ALL_BIOME_CATEGORIES.map((c) => ({ name: BIOME_CATEGORY_LABELS[c], value: c }));

/** Guilds with BiomeHunt data (bh_guilds) the bot is no longer a member of. */
async function findStaleGuilds(client: BotClient): Promise<StaleGuildSummary[]> {
    const allGuildIds = await getAllGuildIds();
    const staleIds = allGuildIds.filter((id) => !client.guilds.cache.has(id));
    return getGuildDataSummary(staleIds);
}

function formatGuildList(guilds: StaleGuildSummary[]): string {
    return guilds.map((g) => `- \`${g.guild_id}\` - ${g.user_count} user(s), ${g.macro_channel_count} macro channel(s)`).join("\n");
}

export default defineCommand({
    name: "bh-owner",
    description: "Bot-owner housekeeping for BiomeHunt data across all guilds.",
    category: CommandCategory.ADMIN,
    botOwnerOnly: true,
    showOnHelp: false,

    options: new SlashCommandBuilder()
        .addSubcommand((s) => s.setName("stale").setDescription("Lists guilds with BiomeHunt data the bot is no longer a member of."))
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
                .addStringOption((o) =>
                    o
                        .setName("biome")
                        .setDescription("Only this specific biome")
                        .addChoices(...BIOME_ONLY_CHOICES),
                )
                .addStringOption((o) =>
                    o
                        .setName("category")
                        .setDescription("Only this biome category (ignored if biome is given)")
                        .addChoices(...BIOME_CATEGORY_CHOICES),
                ),
        )
        .addSubcommand((s) =>
            s
                .setName("reroll-flower")
                .setDescription("Rerolls a user's Flower - the only admin-side way to change one once set.")
                .addStringOption((o) => o.setName("discord_user_id").setDescription("Target user's Discord ID").setRequired(true))
                .addStringOption((o) =>
                    o
                        .setName("guild_id")
                        .setDescription("Guild ID - only needed if the user has a profile in more than one guild")
                        .setRequired(false),
                ),
        )
        // See `runSimulateBiome`'s TSDoc: a dry run (the default) never touches the user's stats;
        // `dry_run:false` inserts a REAL event that counts and can grant real rewards.
        .addSubcommand((s) =>
            s
                .setName("simulate-biome")
                .setDescription("TESTING: fakes a biome find to test the forward (and, for rare biomes, the community vote).")
                .addStringOption((o) =>
                    o
                        .setName("biome")
                        .setDescription("Biome to simulate (default Glitched)")
                        .addChoices(...BIOME_ONLY_CHOICES),
                )
                .addUserOption((o) => o.setName("user").setDescription("Target user (default: you)"))
                .addBooleanOption((o) =>
                    o.setName("dry_run").setDescription("Leave the user's stats untouched - no event, seeds, XP or badges (default true)"),
                ),
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

        if (sub === "simulate-biome") {
            await runSimulateBiome(ctx);
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
        if (Number.isNaN(afterDate.getTime())) {
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
                logger.info(
                    `Backfilled ${plan.events.length} event(s) for user ${user.id} in guild ${guildId}: +${plan.totalSeeds} seeds, +${plan.totalXp} xp`,
                );
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
        await replyPlain(
            EmbedFormatter.error(`Flowers aren't enabled in guild \`${guildId}\`. Enable \`EXPERIMENT_WEBHOOK_FLOWERS\` there first.`),
        );
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
        EmbedFormatter.success(
            `<@${discordUserId}>'s flower rerolled in guild \`${guildId}\`: **${FLOWER_META[flower].label}** (${FLOWER_META[flower].rarity}).`,
        ),
    );
}

/** Injectable for `resolveSimulateBiomeTarget`'s tests - no DB, no Discord. */
export interface SimulateBiomeDeps {
    getUserByDiscordId: typeof getUserByDiscordId;
    getForwardConfig: typeof getForwardConfig;
}

function defaultSimulateBiomeDeps(): SimulateBiomeDeps {
    return { getUserByDiscordId, getForwardConfig };
}

/**
 * Validates the preconditions for `/bh-owner simulate-biome`, split out from `runSimulateBiome`
 * so its three error paths (unknown biome, no profile, no forward configured) can be unit-tested
 * without a real Discord context or a database. The biome is checked first, and against
 * `BIOME_META` directly rather than trusting the slash option's `choices` - a prefix invocation
 * isn't restricted to them (see `command-args.ts`: "Prefix does NOT enforce ... choices").
 */
export async function resolveSimulateBiomeTarget(
    guildId: string,
    discordUserId: string,
    biome: string,
    deps: SimulateBiomeDeps = defaultSimulateBiomeDeps(),
): Promise<{ userId: number; forwardChannelId: string }> {
    if (!BIOME_META[biome]) throw new BiomeHuntError(`\`${biome}\` is not a known biome.`);

    const user = await deps.getUserByDiscordId(guildId, discordUserId);
    if (!user) throw new BiomeHuntError(`<@${discordUserId}> has no profile in this server.`);

    const forward = await deps.getForwardConfig(guildId, biome);
    if (!forward)
        throw new BiomeHuntError(`No forward is configured for ${formatBiomeName(biome)} - set one with \`/bh-admin forward set\`.`);

    return { userId: user.id, forwardChannelId: forward.channel_id };
}

/**
 * TESTING ONLY - fakes a biome find and runs it through the exact same forward pipeline
 * (`forwardBiome`) as a real one; a rare biome also opens the community vote.
 *
 * `dry_run` (default true) inserts NO event: the vote row gets a `null` `event_id`, which the
 * close/decide path already treats as "nothing to reward or delete" - so the user's biome count,
 * Seeds, XP and badges never change, whatever the vote outcome. With `dry_run:false` it inserts a
 * REAL `bh_activity_events` row (same insert as `activity-ingest.service.ts`) with the same
 * consequences as an actual find: it counts in stats, a non-rare biome is rewarded right away, and
 * a rare one is rewarded (or its event deleted) through the normal vote/review flow.
 */
async function runSimulateBiome(ctx: CommandContext): Promise<void> {
    if (!ctx.guild) throw new UserFacingError("Run this in a server.");
    const guild = ctx.guild;

    const biome = (ctx.args.getString("biome") ?? "GLITCHED").toUpperCase();
    const targetUser = (await ctx.args.getUser("user")) ?? ctx.user;
    const dryRun = ctx.args.getBoolean("dry_run") ?? true;

    const { userId, forwardChannelId } = await resolveSimulateBiomeTarget(guild.id, targetUser.id, biome);

    const now = new Date();
    let eventId: number | null = null;
    if (!dryRun) {
        eventId = await transaction((client) =>
            insertEventIfNew(client, userId, `sim-${newTraceRef()}`, biome, "simulated", "started", now),
        );
        if (eventId === null) throw new BiomeHuntError("Failed to create the simulated event - try again.");
        if (BIOME_META[biome].category !== "rare") await grantBiomeReward(guild.id, userId, eventId, biome);
    }

    const parsed: ParsedEvent = { biome, macroType: "simulated", eventType: "started", eventTimestamp: now, serverLink: null };
    const jumpLink =
        ctx.raw.kind === "prefix"
            ? `https://discord.com/channels/${guild.id}/${ctx.raw.message.channelId}/${ctx.raw.message.id}`
            : `https://discord.com/channels/${guild.id}/${ctx.raw.interaction.channelId}`;

    await forwardBiome(ctx.client, guild.id, userId, parsed, eventId, jumpLink);

    logger.info(`Simulated ${biome} for user ${userId} (guild ${guild.id}), ${dryRun ? "dry run" : `event ${eventId}`}`);
    const mode = dryRun ? "Dry run, no event was inserted" : `Event ID: \`#${eventId}\`.`;

    await ctx.reply({
        ...EmbedFormatter.success(
            `Simulated ${formatBiomeName(biome)} for <@${targetUser.id}> - forwarded to <#${forwardChannelId}>.\n${mode}`,
        ),
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
        await ctx.reply(EmbedFormatter.info(guildId ? `Guild \`${guildId}\` has no BiomeHunt data.` : "No stale guilds to clean up."));
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
