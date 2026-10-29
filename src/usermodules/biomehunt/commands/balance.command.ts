import { SlashCommandBuilder } from "discord.js";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import { BALANCE_DESCRIPTION, BALANCE_USER_DESCRIPTION, runBalance } from "./bh.command";

/** Alias of `/bh balance` - same options, same code. */
export default defineCommand({
    name: "balance",
    description: BALANCE_DESCRIPTION,
    category: CommandCategory.UTILITY,
    showOnHelp: true,
    guildOnly: true,

    options: new SlashCommandBuilder().addUserOption((o) => o.setName("user").setDescription(BALANCE_USER_DESCRIPTION)),

    run: runBalance,
});
