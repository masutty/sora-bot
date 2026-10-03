import { SlashCommandBuilder } from "discord.js";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import { addNetworkAdminSubcommands, runNetworkAdminSubcommand } from "./network-admin";

/**
 * The bot owner's Network tools (approve, remove, force, ban, close-vote, announce, lookup,
 * overview) - kept off `/network`, which every server admin sees.
 */
export default defineCommand({
    name: "network-admin",
    description: "Bot owner tools for the Network.",
    category: CommandCategory.ADMIN,
    botOwnerOnly: true,
    showOnHelp: false,

    options: addNetworkAdminSubcommands(new SlashCommandBuilder()),

    async run(ctx) {
        await ctx.defer({ ephemeral: true });
        await runNetworkAdminSubcommand(ctx);
    },
});
