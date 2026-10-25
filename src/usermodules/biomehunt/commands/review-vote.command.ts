import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import { openVoteReview, requireVoteIdOfMessage } from "../views/vote-review.open";

/** Right-click a forward or Network Mirror, then Apps, then "Review vote": the same screen as `/admin review-vote`. */
export default defineCommand({
    name: "Review vote",
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
