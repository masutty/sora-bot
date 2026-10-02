import { expect, test } from "bun:test";
import type { BotClient } from "@/core/bot-client";
import type { CastNetworkBallotResult } from "../services/network-vote.service";
import { VoteChoice } from "../types";
import { type NetworkVoteComponentDeps, networkVoteComponent } from "./network-vote.component";

function fakeInteraction(guildId: string | null) {
    const log: string[] = [];
    const replies: string[] = [];
    const interaction = {
        user: { id: "u1" },
        guildId,
        isButton: () => true,
        deferReply: async () => {
            log.push("deferReply");
        },
        editReply: async (p: { content: string }) => {
            log.push("editReply");
            replies.push(p.content);
        },
    };
    return { interaction, log, replies };
}

function fakeDeps(result: CastNetworkBallotResult) {
    const casts: Array<{ postId: string; userId: string; guildId: string; choice: VoteChoice }> = [];
    const deps: NetworkVoteComponentDeps = {
        cast: async (_client, postId, userId, guildId, choice) => {
            casts.push({ postId, userId, guildId, choice });
            return result;
        },
    };
    return { deps, casts };
}

const client = {} as BotClient;
const board = { servers: { real: 1, fake: 0 }, people: { real: 2, fake: 0 } };

test("net-vote: a click casts for the clicked server and answers privately with the scoreboard", async () => {
    const { deps, casts } = fakeDeps({ kind: "ok", scoreboard: board });
    const { interaction, log, replies } = fakeInteraction("gB");
    await networkVoteComponent(deps).handle(interaction as never, ["p1", "fake"], client);
    expect(casts).toEqual([{ postId: "p1", userId: "u1", guildId: "gB", choice: VoteChoice.FAKE }]);
    expect(log).toEqual(["deferReply", "editReply"]);
    expect(replies[0]).toContain("Vote recorded");
    expect(replies[0]).toContain("Real **1** server (2)");
});

test("net-vote: the finder is told they can't vote on their own find", async () => {
    const { deps } = fakeDeps({ kind: "finder" });
    const { interaction, replies } = fakeInteraction("gB");
    await networkVoteComponent(deps).handle(interaction as never, ["p1", "real"], client);
    expect(replies[0]).toContain("your own find");
});

test("net-vote: malformed parts or a click outside a server cast nothing", async () => {
    const { deps, casts } = fakeDeps({ kind: "ok", scoreboard: board });
    await networkVoteComponent(deps).handle(fakeInteraction("gB").interaction as never, ["p1", "maybe"], client);
    await networkVoteComponent(deps).handle(fakeInteraction(null).interaction as never, ["p1", "real"], client);
    expect(casts).toHaveLength(0);
});
