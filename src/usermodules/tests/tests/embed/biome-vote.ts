import { MessageFlags } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { VoteStatus } from "@/usermodules/biomehunt/types";
import { buildForwardContainer, type VoteRenderInfo } from "@/usermodules/biomehunt/views/forward-post.view";
import type { TestCase, TestPayload } from "../../registry";

// A fake vote id: the Real/Fake buttons on the "open" page are real customIds, so clicking them in
// this preview reaches the vote component and gets its normal "no vote with that id" answer.
const FAKE_VOTE_ID = "preview0";
const FAKE_JUMP_LINK = "https://discord.com/channels/0/0/0";
const FAKE_SERVER_LINK = "https://www.roblox.com/games/15532962292";

/** One page per vote state, in the order a vote can go through them. */
function voteStates(adminId: string): Array<Omit<VoteRenderInfo, "voteId">> {
    return [
        { status: VoteStatus.OPEN, tally: { real: 2, fake: 1 } },
        { status: VoteStatus.NO_VOTES, tally: { real: 0, fake: 0 } },
        { status: VoteStatus.TIE, tally: { real: 2, fake: 2 } },
        { status: VoteStatus.COMMUNITY_REAL, tally: { real: 4, fake: 1 } },
        { status: VoteStatus.COMMUNITY_FAKE, tally: { real: 1, fake: 4 } },
        { status: VoteStatus.ADMIN_CONFIRMED, tally: { real: 1, fake: 1 }, decidedByUserId: adminId },
        { status: VoteStatus.ADMIN_DENIED, tally: { real: 1, fake: 1 }, decidedByUserId: adminId },
    ];
}

export default {
    description: "The rare-biome forward in every community-vote state (open, no votes, tie, community real/fake, admin confirmed/denied).",
    pages(client: BotClient): TestPayload[] {
        const adminId = client.user?.id ?? "0";
        return voteStates(adminId).map((vote) => {
            const container = buildForwardContainer({
                biome: "GLITCHED",
                roleId: null,
                serverLink: FAKE_SERVER_LINK,
                jumpLink: FAKE_JUMP_LINK,
                findCount: 2,
                vote: { ...vote, voteId: FAKE_VOTE_ID },
            });
            return { flags: MessageFlags.IsComponentsV2, components: [container] } as TestPayload;
        });
    },
} satisfies TestCase;
