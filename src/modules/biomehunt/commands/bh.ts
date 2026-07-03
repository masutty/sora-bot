import {
    SlashCommandBuilder,
    channelMention,
    ChannelType,
    EmbedBuilder,
    Colors,
} from "discord.js";
import type { ChatInputCommandInteraction, SlashCommandSubcommandBuilder, TextChannel } from "discord.js";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import { getGuildConfig, setGuildConfig } from "../services/GuildConfigCache";
import { ActivityProcessor } from "../services/ActivityProcessor";
import { registerUser } from "../tasks/status_task";
import { encrypt, decrypt } from "../../../utils/crypto";
import * as userRepository from "@/modules/biomehunt/repository/User";
import { query } from "../../../database/connection";

/* ───────────────────────────────────────────── */
/* Row types                                    */
/* ───────────────────────────────────────────── */

interface UserProfileRow {
    user_id: string;
    guild_id: string;
    dedicated_channel_id: string;
    webhook_url: string | null;
    current_state: string;
    last_activity: string | null;
    total_messages: string;
    total_active_s: string;
    biome_counts: Record<string, number>;
}

interface StatRow {
    current_state: string;
    count: string;
}

interface BiomeTotalRow {
    total: string;
}

/* ───────────────────────────────────────────── */
/* Command                                      */
/* ───────────────────────────────────────────── */

// const summary = {
//     opt: (sub: SlashCommandSubcommandBuilder) => {
//         return sub
//             .setName("summary")
//             .setDescription("View server-wide biome hunting statistics.");
//     },
//     execute: async (interaction: ChatInputCommandInteraction) => {
//         return null
//     }
// }

export default defineCommand({
    name: "bh",
    description: "BiomeHunter commands.",
    category: CommandCategory.GENERAL,

    showOnHelp: true,

    options: new SlashCommandBuilder()
        .addSubcommand(sub =>
            sub
                .setName("setup")
                .setDescription("Create your personal macro channel."),
        )
        .addSubcommand(sub =>
            sub
                .setName("webhook")
                .setDescription("Get your webhook URL. Can only be used inside your own channel."),
        )
        .addSubcommand(sub =>
            sub
                .setName("profile")
                .setDescription("View your biome hunting statistics."),
        ),
        // .addSubcommand(summary.opt),

    async executeAsSlash(interaction) {
        if (!interaction.guildId) {
            await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
            return;
        }

        const sub = interaction.options.getSubcommand(true);
        await interaction.deferReply({ ephemeral: true });

        try {
            switch (sub) {
                case "setup": await handleSetup(interaction); break;
                case "webhook": await handleWebhook(interaction); break;
                case "profile": await handleProfile(interaction); break;
                case "summary": await handleSummary(interaction); break;
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await interaction.editReply(`❌ ${msg}`);
        }
    },
});


/* ───────────────────────────────────────────── */
/* /bh setup                                    */
/* ───────────────────────────────────────────── */

async function handleSetup(interaction: ChatInputCommandInteraction): Promise<void> {
    const { guildId, user } = interaction;

    // Guard: already registered
    const existing = await getUserProfile(user.id, guildId!);
    if (existing) {
        await interaction.editReply(
            `You already have a macro channel: ${channelMention(existing.dedicated_channel_id)}.`,
        );
        return;
    }

    const config = await getGuildConfig(guildId!);
    if (!config || config.macroCategoryIds.length === 0) {
        await interaction.editReply(
            "This server has no macro categories configured yet. Ask an admin to run `/bh-admin set-macro-cat`.",
        );
        return;
    }

    // Pick the least populated category
    const categoryId = await leastPopulatedCategory(config.macroCategoryIds);

    const MAX_CHANNEL_NAME = 100;
    const PREFIX = "・";

    const sanitizedUsername = user.username
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-");

    const maxUsernameLength = MAX_CHANNEL_NAME - PREFIX.length;

    const trimmedUsername = sanitizedUsername
        .slice(0, maxUsernameLength)
        .replace(/-+$/g, "");

    const channelName = PREFIX + trimmedUsername;

    const guild = interaction.guild!;
    const channel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: categoryId,
        topic: `Macro channel for ${user.tag}`,
    });

    // Persist profile
    await query(
        `
        INSERT INTO bh_user_profiles (user_id, guild_id, dedicated_channel_id)
        VALUES ($1, $2, $3)
        ON CONFLICT (user_id, guild_id) DO NOTHING
        `,
        [user.id, guildId, channel.id],
    );

    // Register in the channel index so messages are processed immediately
    ActivityProcessor.registerChannel(channel.id, user.id, guildId!);

    // Register in the StateEngine heap
    registerUser(user.id, guildId!);

    await interaction.editReply(
        `✅ Your macro channel has been created: ${channelMention(channel.id)}\n` +
        `Head there and run \`/bh webhook\` to get your webhook URL.`,
    );
}

/* ───────────────────────────────────────────── */
/* /bh webhook                                  */
/* ───────────────────────────────────────────── */

async function handleWebhook(interaction: ChatInputCommandInteraction): Promise<void> {
    const { guildId, user, channelId } = interaction;

    const profile = await userRepository.getUserProfile(user.id, guildId!);
    if (!profile) {
        await interaction.editReply("You have not completed your setup yet. Run `/bh setup` first.");
        return;
    }

    // Guard: wrong channel
    if (channelId !== profile.dedicatedChannelId) {
        await interaction.editReply(
            `❌ You need to run it on your own channel dummy! Go to ${channelMention(profile.dedicatedChannelId)}.`,
        );
        return;
    }

    // Guard: webhook already issued
    if (profile.webhookUrl !== null) {
        await interaction.editReply(
            "❌ I already sent you a webhook! If you need to recreate it, contact an administrator.",
        );
        return;
    }

    const channel = interaction.channel!;

    if (!channel.isTextBased() || channel.isDMBased()) {
        await interaction.editReply("Cannot create a webhook in this channel type.");
        return;
    }

    // ugly as fuck i dont fucking care die explode
    const webhook = await (channel as TextChannel).createWebhook({
        name: `${user.username} - biomehunt`,
        reason: "BiomeHunt macro webhook",
    });

    try {
        // send webhook privately first
        await user.send(
            `✅ Here is your webhook for ${channelMention(channel.id)}:\n` +
            `\`\`\`\n${webhook.url}\n\`\`\`\n\n` +
            `- *Keep this webhook link private. If it is misused, you will be punished*.\n` +
            `- *Configure this in your macro only. Do not call the webhook directly, you will be punished for misuse.*\n` +
            `- *If you need to recreate your webhook, __contact an administrator__.*`
        );
    } catch {
        // cleanup if DM fails
        await webhook.delete("Failed to deliver webhook via DM");

        await interaction.editReply(
            "❌ I couldn't send you a DM.\n" +
            "Please enable direct messages from server members and try again."
        );
        return;
    }

    const encrypted = encrypt(webhook.url);

    await userRepository.updateUserProfile(user.id, guildId!, {
        webhookId: webhook.id,
        webhookUrl: encrypted,
    });

    await interaction.editReply(
        "✅ I've sent your webhook URL to your DMs. Check your inbox."
    );
}

/* ───────────────────────────────────────────── */
/* /bh profile                                  */
/* ───────────────────────────────────────────── */

async function handleProfile(interaction: ChatInputCommandInteraction): Promise<void> {
    const { guildId, user } = interaction;

    const profile = await getUserProfile(user.id, guildId!);
    if (!profile) {
        await interaction.editReply("You have not completed your setup yet. Run `/bh setup` first.");
        return;
    }

    const stateEmoji: Record<string, string> = {
        green: "🟢",
        yellow: "🟡",
        red: "🔴",
    };

    const lastActive = profile.last_activity
        ? `<t:${Math.floor(new Date(profile.last_activity).getTime() / 1000)}:R>`
        : "*never*";

    const totalBiomes = Object.values(profile.biome_counts ?? {}).reduce((a, b) => a + b, 0);

    const biomeLines = Object.entries(profile.biome_counts ?? {})
        .sort(([, a], [, b]) => b - a)
        .map(([name, count]) => `\`${name}\`: **${count.toLocaleString()}**`)
        .join("\n") || "*none recorded*";

    const embed = new EmbedBuilder()
        .setTitle(`${user.username}'s Biome Profile`)
        .setColor(stateColor(profile.current_state))
        .addFields(
            {
                name: "Status",
                value: `${stateEmoji[profile.current_state] ?? "⚪"} **${profile.current_state.toUpperCase()}**`,
                inline: true,
            },
            {
                name: "Last active",
                value: lastActive,
                inline: true,
            },
            {
                name: "Messages",
                value: Number(profile.total_messages).toLocaleString(),
                inline: true,
            },
            {
                name: "Total biomes found",
                value: totalBiomes.toLocaleString(),
                inline: true,
            },
            {
                name: "Active time",
                value: formatSeconds(Number(profile.total_active_s)),
                inline: true,
            },
            {
                name: "Biome breakdown",
                value: biomeLines,
                inline: false,
            },
        )
        .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
}

/* ───────────────────────────────────────────── */
/* /bh summary                                  */
/* ───────────────────────────────────────────── */

async function handleSummary(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId!;

    const [stateResult, biomeResult, totalResult] = await Promise.all([
        query<StatRow>(
            `
            SELECT current_state, COUNT(*) AS count
            FROM bh_user_profiles
            WHERE guild_id = $1
            GROUP BY current_state
            `,
            [guildId],
        ),
        query<{ biome: string; total: string }>(
            `
            SELECT
                key   AS biome,
                SUM(value::BIGINT) AS total
            FROM bh_user_profiles,
                 jsonb_each_text(biome_counts)
            WHERE guild_id = $1
            GROUP BY key
            ORDER BY total DESC
            LIMIT 10
            `,
            [guildId],
        ),
        query<BiomeTotalRow>(
            `
            SELECT COALESCE(SUM(total_messages), 0) AS total
            FROM bh_user_profiles
            WHERE guild_id = $1
            `,
            [guildId],
        ),
    ]);

    const counts: Record<string, number> = { green: 0, yellow: 0, red: 0 };
    for (const row of stateResult.rows) {
        if (row.current_state in counts) counts[row.current_state] = Number(row.count);
    }

    const totalMessages = Number(totalResult.rows[0]?.total ?? 0);

    const topBiomes = biomeResult.rows.length > 0
        ? biomeResult.rows
            .map((r, i) => `**${i + 1}.** \`${r.biome}\` — ${Number(r.total).toLocaleString()}`)
            .join("\n")
        : "*no biomes recorded*";

    const embed = new EmbedBuilder()
        .setTitle("BiomeHunter — Server Summary")
        .setColor(Colors.Blurple)
        .addFields(
            { name: "🟢 Active", value: counts.green.toLocaleString(), inline: true },
            { name: "🟡 Idle", value: counts.yellow.toLocaleString(), inline: true },
            { name: "🔴 Offline", value: counts.red.toLocaleString(), inline: true },
            {
                name: "Total registered hunters",
                value: (counts.green + counts.yellow + counts.red).toLocaleString(),
                inline: true,
            },
            {
                name: "Total messages processed",
                value: totalMessages.toLocaleString(),
                inline: true,
            },
            {
                name: "Top 10 biomes",
                value: topBiomes,
                inline: false,
            },
        )
        .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
}

/* ───────────────────────────────────────────── */
/* Helpers                                      */
/* ───────────────────────────────────────────── */

async function getUserProfile(
    userId: string,
    guildId: string,
): Promise<UserProfileRow | null> {
    const result = await query<UserProfileRow>(
        `
        SELECT *
        FROM bh_user_profiles
        WHERE user_id = $1 AND guild_id = $2
        `,
        [userId, guildId],
    );
    return result.rows[0] ?? null;
}

async function leastPopulatedCategory(categoryIds: string[]): Promise<string> {
    // Count how many macro channels exist in each category via the DB.
    // The channel's parent_id is not stored — count by prefix isn't possible,
    // so we resolve via a quick Discord API call on guild channels.
    // This runs once per /bh setup so the extra fetch is acceptable.

    // Return the first category as fallback; the loop below will override it.
    let bestId = categoryIds[0];
    let bestCount = Infinity;

    const result = await query<{ dedicated_channel_id: string }>(
        `SELECT dedicated_channel_id FROM bh_user_profiles`,
    );

    // We don't store parent_id, so count is approximated as equal distribution.
    // For accurate counting, store category_id on the profile row and use:
    //   SELECT category_id, COUNT(*) FROM bh_user_profiles GROUP BY category_id
    // For now, round-robin: pick the category with fewest DB entries via index arithmetic.
    const index = result.rows.length % categoryIds.length;
    bestId = categoryIds[index];

    return bestId;
}

function stateColor(state: string): number {
    if (state === "green") return Colors.Green;
    if (state === "yellow") return Colors.Yellow;
    return Colors.Red;
}

function formatSeconds(total: number): string {
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}
