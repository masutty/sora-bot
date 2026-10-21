import { SlashCommandBuilder } from "discord.js";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import { PROFILE_DESCRIPTION, PROFILE_USER_DESCRIPTION, runProfile } from "./bh.command";

/** Alias of `/bh profile` - same options, same code. */
export default defineCommand({
    name: "profile",
    description: PROFILE_DESCRIPTION,
    category: CommandCategory.UTILITY,
    showOnHelp: true,
    guildOnly: true,

    options: new SlashCommandBuilder().addUserOption((o) => o.setName("user").setDescription(PROFILE_USER_DESCRIPTION)),

    run: runProfile,
});
