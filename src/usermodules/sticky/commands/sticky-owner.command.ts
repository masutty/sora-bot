import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import * as limits from "../repository/limits.repository";
import { guildUsage } from "../repository/stickies.repository";
import { ownerView } from "../views/owner.view";

export default defineCommand({
    name: "sticky-owner",
    description: "Set the sticky limits.",
    category: CommandCategory.ADMIN,
    botOwnerOnly: true,
    guildOnly: false,

    async run(ctx) {
        await ctx.open(
            ownerView({ limits, usage: guildUsage, guildName: (id) => ctx.client.guilds.cache.get(id)?.name ?? null }),
            undefined,
            { ephemeral: true },
        );
    },
});
