import { SlashCommandBuilder } from "discord.js";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import { RARE_FINDS_DESCRIPTION, RARE_FINDS_USER_DESCRIPTION, runRareFinds } from "./bh.command";

/** Alias of `/bh rare-finds` - same options, same code. */
export default defineCommand({
    name: "rare-finds",
    description: RARE_FINDS_DESCRIPTION,
    category: CommandCategory.UTILITY,
    showOnHelp: true,
    guildOnly: true,

    options: new SlashCommandBuilder().addUserOption((o) => o.setName("user").setDescription(RARE_FINDS_USER_DESCRIPTION)),

    run: runRareFinds,
});
