import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import { REROLL_DESCRIPTION, runReroll } from "./bh.command";

/** Alias of `/bh reroll` - same code. */
export default defineCommand({
    name: "reroll",
    description: REROLL_DESCRIPTION,
    category: CommandCategory.UTILITY,
    showOnHelp: true,
    guildOnly: true,

    run: runReroll,
});
