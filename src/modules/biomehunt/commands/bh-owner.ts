import { SlashCommandBuilder } from "discord.js";
import type { Message } from "discord.js";
import type { BotClient } from "@/core/BotClient";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import { confirmAction, type ConfirmPayload } from "@/utils/confirm";
import { EmbedFormatter, type FormattedReply } from "@/utils/format";
import { Logger } from "@/utils/logging";
import { deleteGuildData, getAllGuildIds, getGuildDataSummary, type StaleGuildSummary } from "../repository/guilds";

const logger = new Logger("biomehunt.commands.bh-owner");

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
        ),

    // ── Slash ─────────────────────────────────────────────────────────────────
    async executeAsSlash(interaction, client) {
        const sub = interaction.options.getSubcommand(true);
        await interaction.deferReply({ ephemeral: true });

        if (sub === "stale") {
            await interaction.editReply(await renderStaleList(client));
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
                    "`!bh-owner stale` - list stale guilds\n`!bh-owner stale-cleanup [guild_id]` - clean up one guild, or every stale guild if omitted",
                ),
            );
            return;
        }

        if (sub === "stale") {
            await message.reply(await renderStaleList(client));
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
