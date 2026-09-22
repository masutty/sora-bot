import { SlashCommandBuilder } from "discord.js";
import type { Message } from "discord.js";
import type { BotClient } from "@/core/BotClient";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import { confirmAction, type ConfirmPayload } from "@/utils/confirm";
import { EmbedFormatter, type FormattedReply } from "@/utils/format";
import { Logger } from "@/utils/logging";
import { applyFlowerReroll } from "./adminMemberActions";
import { FLOWER_META } from "../flowers";
import { isFlagEnabled } from "../repository/flags";
import { deleteGuildData, getAllGuildIds, getGuildDataSummary, type StaleGuildSummary } from "../repository/guilds";
import { getUserByDiscordId, getUsersByDiscordId } from "../repository/users";
import { applyUserRewardBackfill, planUserRewardBackfill } from "../services/BiomeRewardEngine";
import {
    ALL_BIOME_CATEGORIES, BiomeHuntError, BIOME_CATEGORY_LABELS, BIOME_ONLY_CHOICES, formatBiomeName, getBiomesByCategory,
    type BiomeCategory,
} from "../types";

const logger = new Logger("biomehunt.commands.bh-owner");

const BIOME_CATEGORY_CHOICES = ALL_BIOME_CATEGORIES.map((c) => ({ name: BIOME_CATEGORY_LABELS[c], value: c }));

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
        ),

    // ── Slash ─────────────────────────────────────────────────────────────────
    async executeAsSlash(interaction, client) {
        const sub = interaction.options.getSubcommand(true);
        await interaction.deferReply({ ephemeral: true });

        if (sub === "stale") {
            await interaction.editReply(await renderStaleList(client));
            return;
        }

        if (sub === "recalculate-user") {
            await runRecalculateUser(
                {
                    guildId: interaction.options.getString("guild_id", true),
                    discordUserId: interaction.options.getString("discord_user_id", true),
                    afterDateStr: interaction.options.getString("after_date"),
                    biome: interaction.options.getString("biome"),
                    category: interaction.options.getString("category") as BiomeCategory | null,
                },
                interaction.user.id,
                (payload) => interaction.editReply(payload),
                (reply) => interaction.editReply(reply),
            );
            return;
        }

        if (sub === "reroll-flower") {
            await runOwnerRerollFlower(
                {
                    discordUserId: interaction.options.getString("discord_user_id", true),
                    guildId: interaction.options.getString("guild_id"),
                },
                client,
                (reply) => interaction.editReply(reply),
            );
            return;
        }

        await runStaleCleanup(
            client,
            interaction.options.getString("guild_id"),
            interaction.user.id,
            (payload) => interaction.editReply(payload),
            (reply) => interaction.editReply(reply),
        );
    },

    // ── Prefix ────────────────────────────────────────────────────────────────
    async executeAsPrefix(message, args, client) {
        const sub = args.getSubcommand();
        if (!sub) {
            await message.reply(
                EmbedFormatter.warn(
                    "`!bh-owner stale` - list stale guilds\n`!bh-owner stale-cleanup [guild_id]` - clean up one guild, or every stale guild if omitted\n" +
                    "`!bh-owner recalculate-user <guild_id> <discord_user_id> [after_date] [biome] [category]` - backfill missing Seeds/XP\n" +
                    "`!bh-owner reroll-flower <discord_user_id> [guild_id]` - reroll a user's Flower",
                ),
            );
            return;
        }

        if (sub === "stale") {
            await message.reply(await renderStaleList(client));
            return;
        }

        if (sub === "recalculate-user") {
            await runRecalculateUser(
                {
                    guildId: args.getString("guild_id"),
                    discordUserId: args.getString("discord_user_id"),
                    afterDateStr: args.getString("after_date"),
                    biome: args.getString("biome"),
                    category: args.getString("category") as BiomeCategory | null,
                },
                message.author.id,
                (payload) => message.reply(payload),
                (reply) => message.reply(reply),
            );
            return;
        }

        if (sub === "reroll-flower") {
            await runOwnerRerollFlower(
                {
                    discordUserId: args.getString("discord_user_id"),
                    guildId: args.getString("guild_id"),
                },
                client,
                (reply) => message.reply(reply),
            );
            return;
        }

        await runStaleCleanup(
            client,
            args.getString("guild_id"),
            message.author.id,
            (payload) => message.reply(payload),
            (reply) => message.reply(reply),
        );
    },
});

interface RecalculateUserArgs {
    guildId: string | null;
    discordUserId: string | null;
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
async function runRecalculateUser(
    args: RecalculateUserArgs,
    invokerId: string,
    send: (payload: ConfirmPayload) => Promise<Message>,
    replyPlain: (reply: FormattedReply) => Promise<unknown>,
): Promise<void> {
    if (!args.guildId || !args.discordUserId) {
        await replyPlain(EmbedFormatter.error("Missing required argument: guild_id and discord_user_id are both required."));
        return;
    }

    let afterDate: Date | null = null;
    if (args.afterDateStr) {
        afterDate = new Date(args.afterDateStr);
        if (isNaN(afterDate.getTime())) {
            await replyPlain(EmbedFormatter.error("Invalid after_date - use YYYY-MM-DD."));
            return;
        }
    }

    const user = await getUserByDiscordId(args.guildId, args.discordUserId);
    if (!user) {
        await replyPlain(EmbedFormatter.info(`<@${args.discordUserId}> has no profile in guild \`${args.guildId}\`.`));
        return;
    }

    const biomes = args.biome ? [args.biome] : args.category ? getBiomesByCategory(args.category) : null;

    const plan = await planUserRewardBackfill(user.id, { afterDate, biomes });
    if (plan.events.length === 0) {
        await replyPlain(EmbedFormatter.info(`<@${args.discordUserId}> has no un-rewarded biome finds matching those filters.`));
        return;
    }

    const filterParts = [
        afterDate ? `since ${afterDate.toISOString().slice(0, 10)}` : null,
        args.biome ? formatBiomeName(args.biome) : args.category ? BIOME_CATEGORY_LABELS[args.category] : null,
    ].filter((p): p is string => p !== null);

    const { guildId, discordUserId } = args;

    await confirmAction({
        invokerId,
        title: `Backfill Seeds/XP for <@${discordUserId}> in guild \`${guildId}\`?`,
        fields: [
            { label: "Events to backfill", value: String(plan.events.length) },
            { label: "Seeds to grant", value: String(plan.totalSeeds) },
            { label: "XP to grant", value: String(plan.totalXp) },
            { label: "Filters", value: filterParts.length > 0 ? filterParts.join(", ") : "none" },
            ...(plan.skippedUnknownCount > 0 ? [{ label: "Skipped (unknown biome)", value: String(plan.skippedUnknownCount) }] : []),
        ],
        send,
        onConfirm: async () => {
            const updated = await applyUserRewardBackfill(user.id, plan);
            logger.info(`Backfilled ${plan.events.length} event(s) for user ${user.id} in guild ${guildId}: +${plan.totalSeeds} seeds, +${plan.totalXp} xp`);
            return EmbedFormatter.success(
                `Backfilled ${plan.events.length} event(s) for <@${discordUserId}>: +${plan.totalSeeds} 🌱, +${plan.totalXp} XP.\n` +
                `New balance: ${updated.seeds} 🌱, ${updated.xp} XP.`,
            );
        },
    });
}

interface RerollFlowerArgs {
    discordUserId: string | null;
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
 * allowed to change once set (see `assignFlower` in guildSetup.ts, which reuses an existing Flower
 * rather than re-rolling it on setup/force-setup).
 */
async function runOwnerRerollFlower(
    args: RerollFlowerArgs,
    client: BotClient,
    replyPlain: (reply: FormattedReply) => Promise<unknown>,
): Promise<void> {
    if (!args.discordUserId) {
        await replyPlain(EmbedFormatter.error("Missing required argument: discord_user_id."));
        return;
    }
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

    try {
        const { flower } = await applyFlowerReroll(client, user.id);
        logger.info(`Rerolled Flower for user ${user.id} (guild ${guildId}): ${flower}`);
        await replyPlain(
            EmbedFormatter.success(`<@${discordUserId}>'s flower rerolled in guild \`${guildId}\`: **${FLOWER_META[flower].label}** (${FLOWER_META[flower].rarity}).`),
        );
    } catch (err) {
        const text = err instanceof BiomeHuntError ? err.message : "Something went wrong applying the Flower.";
        await replyPlain(EmbedFormatter.error(text));
    }
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
async function runStaleCleanup(
    client: BotClient,
    guildId: string | null,
    invokerId: string,
    send: (payload: ConfirmPayload) => Promise<Message>,
    replyPlain: (reply: FormattedReply) => Promise<unknown>,
): Promise<void> {
    const targets = guildId ? await getGuildDataSummary([guildId]) : await findStaleGuilds(client);

    if (!targets.length) {
        await replyPlain(
            EmbedFormatter.info(guildId ? `Guild \`${guildId}\` has no BiomeHunt data.` : "No stale guilds to clean up."),
        );
        return;
    }

    const totalUsers = targets.reduce((sum, g) => sum + g.user_count, 0);
    const totalChannels = targets.reduce((sum, g) => sum + g.macro_channel_count, 0);

    await confirmAction({
        invokerId,
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
        send,
        onConfirm: async () => {
            const guildIds = targets.map((g) => g.guild_id);
            const deleted = await deleteGuildData(guildIds);
            logger.info(`Deleted BiomeHunt data for ${deleted} guild(s): ${guildIds.join(", ")}`);
            return EmbedFormatter.success(`Deleted BiomeHunt data for ${deleted} guild(s).`);
        },
    });
}
