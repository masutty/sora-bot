import { SlashCommandBuilder } from "discord.js";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import { runSession, SESSION_DESCRIPTION, SESSION_ID_DESCRIPTION } from "./bh.command";

/** Alias of `/bh session` - same options, same code. */
export default defineCommand({
    name: "session",
    description: SESSION_DESCRIPTION,
    category: CommandCategory.UTILITY,
    showOnHelp: true,
    guildOnly: true,

    options: new SlashCommandBuilder().addIntegerOption((o) =>
        o.setName("id").setDescription(SESSION_ID_DESCRIPTION).setRequired(true).setMinValue(1),
    ),

    run: runSession,
});
