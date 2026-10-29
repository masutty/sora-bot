import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import { openVoteReview, requireVoteIdOfMessage } from "../views/vote-review.open";

/** Right-click a forward or Network Mirror, then Apps, then "Check vote": the same screen as `/admin check-vote`. */
export default defineCommand({
    name: "Check vote",
    description: "See who voted on a rare find and mark it real or fake.",
    category: CommandCategory.ADMIN,
    contextMenu: "message",
    showOnHelp: false,
    adminOnly: true,
    guildOnly: true,

    async run(ctx) {
        await openVoteReview(ctx, ctx.guild, await requireVoteIdOfMessage(ctx.guild.id, ctx.args.getTargetMessageId()));
    },
});
