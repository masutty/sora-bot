import { SlashCommandBuilder } from "discord.js";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";

export default defineCommand({
    name: "echo",
    description: "Repeats a message.",
    category: CommandCategory.UTILITY,
    showOnHelp: false,
    botOwnerOnly: true,

    options: new SlashCommandBuilder().addStringOption((opt) =>
        opt.setName("message").setDescription("Message to repeat").setRequired(true),
    ),

    async run(ctx) {
        // Required on slash, so only a bare prefix `echo` ever reaches the empty case.
        const echoMessage = ctx.args.getString("message");
        if (!echoMessage) {
            await ctx.reply("...What am I supposed to say?");
            return;
        }
        await ctx.reply({ content: echoMessage });
    },
});
