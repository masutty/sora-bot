import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import { runShop, SHOP_DESCRIPTION } from "./bh.command";

/** Alias of `/bh shop` - same code. */
export default defineCommand({
    name: "shop",
    description: SHOP_DESCRIPTION,
    category: CommandCategory.UTILITY,
    showOnHelp: true,
    guildOnly: true,

    run: runShop,
});
