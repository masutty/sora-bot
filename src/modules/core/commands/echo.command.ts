import { SlashCommandBuilder } from "discord.js";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";

export default defineCommand({
    name: "echo",
    description: "Repeats a message.",
    category: CommandCategory.UTILITY,
    showOnHelp: false,
    botOwnerOnly: true,

    options: new SlashCommandBuilder()
        .addStringOption((opt) => opt.setName("message").setDescription("Message to repeat").setRequired(true)),

    async executeAsSlash(interaction, _client) {
        const echoMessage = interaction.options.getString("message", true);
        await interaction.deferReply();
        await interaction.editReply({ content: echoMessage });
    },

    async executeAsPrefix(message, args) {
        const echoMessage = args.getString("message");
        if (!echoMessage) {
            await message.reply("...What am I supposed to say?");
            return;
        }
        await message.reply({ content: echoMessage });
    },
});
