import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import type { Guild, GuildMember } from "discord.js";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import { EmbedFormatter } from "@/utils/format";
import { Logger } from "@/utils/logging";
import { getFailureQuip } from "@/utils/quips";
import { runUserSetup } from "../guildSetup";
import { BiomeHuntError } from "../types";
import { runProfileView } from "./profileViews";

const logger = new Logger("biomehunt.commands.bh");

export default defineCommand({
    name: "bh",
    description: "User commands for biome hunt module",
    category: CommandCategory.UTILITY,
    showOnHelp: true,

    options: new SlashCommandBuilder()
        .addSubcommand((sub) => sub.setName("setup").setDescription("Set up your hunt macro channel."))
        .addSubcommand((sub) => sub.setName("profile").setDescription("View your hunt profile.")),
        // .addSubcommand((sub) => sub.setName("history").setDescription("View your recent activity sessions."))
        // .addSubcommand((sub) => sub.setName("leaderboard").setDescription("View the server's activity leaderboard.")),

    async executeAsSlash(interaction, _client) {
        if (!interaction.guild || !interaction.member) {
            await interaction.reply({ content: "This command only works in a server.", ephemeral: true });
            return;
        }
        const sub = interaction.options.getSubcommand(true);

        if (sub === "profile") {
            await interaction.deferReply();
            await runProfileView(interaction.guild.id, interaction.member as GuildMember, interaction.user.id, (payload) => interaction.editReply(payload));
            return;
        }

        await interaction.deferReply({ ephemeral: sub === "setup" });
        try {
            const embed = await runSubcommand(sub, interaction.guild, interaction.member as GuildMember);
            await interaction.editReply({ embeds: [embed] });
        } catch (err) {
            await interaction.editReply({ embeds: [EmbedFormatter.error(errorMessage(err))] });
        }
    },

    async executeAsPrefix(message, args, _client) {
        if (!message.guild || !message.member) {
            await message.reply("This command only works in a server.");
            return;
        }
        const sub = args.getSubcommand();
        if (!sub) {
            await message.reply({ embeds: [EmbedFormatter.info("Usage: `bh <setup|profile>`")] });
            return;
        }

        if (sub === "profile") {
            await runProfileView(message.guild.id, message.member, message.author.id, (payload) => message.reply(payload));
            return;
        }

        try {
            const embed = await runSubcommand(sub, message.guild, message.member);
            await message.reply({ embeds: [embed] });
        } catch (err) {
            await message.reply({ embeds: [EmbedFormatter.error(errorMessage(err))] });
        }
    },
});

async function runSubcommand(sub: string, guild: Guild, member: GuildMember): Promise<EmbedBuilder> {
    switch (sub) {
        case "setup": {
            const result = await runUserSetup(guild, member);
            return EmbedFormatter.success(`Created: <#${result.channelId}>`);
        }
        default:
            throw new BiomeHuntError(`Unknown subcommand: ${sub}`);
    }
}

function errorMessage(err: unknown): string {
    if (err instanceof BiomeHuntError) return err.message;
    logger.error(err instanceof Error ? err : new Error(String(err)));
    return getFailureQuip();
}
