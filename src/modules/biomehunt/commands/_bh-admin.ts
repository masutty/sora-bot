import { SlashCommandBuilder } from "discord.js";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import { invalidateGuildConfig } from "../services/GuildConfigCache";
import { query } from "../../../database/connection";

export default defineCommand({
    name: "bh-admin",
    description: "BiomeHunter administration.",
    category: CommandCategory.ADMIN,

    adminOnly: true,
    showOnHelp: false,

    options: new SlashCommandBuilder()
        // ── Role & threshold commands ────────────────────────────────────────
        .addSubcommand(sub =>
            sub
                .setName("set-green")
                .setDescription("Set the Green (active) role.")
                .addRoleOption(o =>
                    o.setName("role").setDescription("Role to assign to active users.").setRequired(true),
                ),
        )
        .addSubcommand(sub =>
            sub
                .setName("set-yellow")
                .setDescription("Set the Yellow (idle) role and inactivity threshold.")
                .addRoleOption(o =>
                    o.setName("role").setDescription("Role to assign to idle users.").setRequired(true),
                )
                .addIntegerOption(o =>
                    o
                        .setName("threshold")
                        .setDescription("Seconds of inactivity before GREEN → YELLOW. Default: 300.")
                        .setMinValue(30)
                        .setMaxValue(3600),
                ),
        )
        .addSubcommand(sub =>
            sub
                .setName("set-red")
                .setDescription("Set the Red (offline) role and inactivity threshold.")
                .addRoleOption(o =>
                    o.setName("role").setDescription("Role to assign to offline users.").setRequired(true),
                )
                .addIntegerOption(o =>
                    o
                        .setName("threshold")
                        .setDescription("Seconds of inactivity before YELLOW → RED. Default: 900.")
                        .setMinValue(60)
                        .setMaxValue(86400),
                ),
        )
        // ── Counter channel ──────────────────────────────────────────────────
        .addSubcommand(sub =>
            sub
                .setName("set-count")
                .setDescription("Set the channel where the live activity counter message is posted.")
                .addChannelOption(o =>
                    o.setName("channel").setDescription("Text channel for the counter.").setRequired(true),
                ),
        )
        // ── Macro categories ─────────────────────────────────────────────────
        .addSubcommand(sub =>
            sub
                .setName("set-macro-category")
                .setDescription("Register a category where macro channels will be created.")
                .addStringOption(o =>
                    o.setName("category_id").setDescription("Category channel ID.").setRequired(true),
                ),
        )
        .addSubcommand(sub =>
            sub
                .setName("del-macro-category")
                .setDescription("Remove a category from the macro channel pool.")
                .addStringOption(o =>
                    o.setName("category_id").setDescription("Category channel ID.").setRequired(true),
                ),
        )
        // ── Info ─────────────────────────────────────────────────────────────
        .addSubcommand(sub =>
            sub.setName("config").setDescription("Show the current BiomeHunt configuration."),
        )
        // ── User sub-subcommand ─────────────────────────────────────────────────
        .addSubcommand(sub =>
            sub.setName("user").setDescription("Reset a user's BiomeHunt data completely.")
            .addUserOption(o => o.setName("user").setDescription("User to reset").setRequired(true)),
        ),


    async executeAsSlash(interaction) {
        if (!interaction.guildId) {
            await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
            return;
        }

        const sub = interaction.options.getSubcommand(true);
        await interaction.deferReply({ ephemeral: true });

        try {
            switch (sub) {
                case "set-green": await handleSetGreen(interaction); break;
                case "set-yellow": await handleSetYellow(interaction); break;
                case "set-red": await handleSetRed(interaction); break;
                case "set-count": await handleSetCount(interaction); break;
                case "set-macro-cat": await handleSetMacroCat(interaction); break;
                case "del-macro-cat": await handleDelMacroCat(interaction); break;
                case "config": await handleConfig(interaction); break;
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await interaction.editReply(`❌ ${msg}`);
        }
    },
});

/* ───────────────────────────────────────────── */
/* Subcommand handlers                          */
/* ───────────────────────────────────────────── */

import type { ChatInputCommandInteraction } from "discord.js";

async function handleSetMacroCat(interaction: ChatInputCommandInteraction): Promise<void> {
    const categoryId = interaction.options.getString("category_id", true);
    const guildId = interaction.guildId!;

    // Verify the category exists in this guild
    const category = await interaction.guild!.channels.fetch(categoryId).catch(() => null);
    if (!category || category.type !== 4 /* ChannelType.GuildCategory */) {
        await interaction.editReply("❌ That ID does not correspond to a category in this server.");
        return;
    }

    await query(
        `
        UPDATE bh_guild_config
        SET
            macro_category_ids = array_append(
                array_remove(macro_category_ids, $2),
                $2
            ),
            updated_at = NOW()
        WHERE guild_id = $1
        `,
        [guildId, categoryId],
    );

    invalidateGuildConfig(guildId);

    await interaction.editReply(`✅ Category \`${category.name}\` added to the macro channel pool.`);
}

async function handleDelMacroCat(interaction: ChatInputCommandInteraction): Promise<void> {
    const categoryId = interaction.options.getString("category_id", true);
    const guildId = interaction.guildId!;

    await query(
        `
        UPDATE bh_guild_config
        SET
            macro_category_ids = array_remove(macro_category_ids, $2),
            updated_at = NOW()
        WHERE guild_id = $1
        `,
        [guildId, categoryId],
    );

    invalidateGuildConfig(guildId);

    await interaction.editReply(`✅ Category \`${categoryId}\` removed from the macro channel pool.`);
}
