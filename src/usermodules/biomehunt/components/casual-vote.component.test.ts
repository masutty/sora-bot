import { expect, test } from "bun:test";
import type { BotClient } from "@/core/bot-client";
import type { CastCasualBallotResult } from "../services/casual-vote.service";
import { VoteChoice } from "../types";
import { casualVoteComponent } from "./casual-vote.component";

function fakeInteraction() {
    const log: string[] = [];
    const replies: string[] = [];
    const interaction = {
        user: { id: "u1" },
        isButton: () => true,
        deferUpdate: async () => {
            log.push("deferUpdate");
        },
        followUp: async (p: { content: string }) => {
            log.push("followUp");
            replies.push(p.content);
        },
    };
    return { interaction, log, replies };
}

const client = {} as BotClient;

async function click(result: CastCasualBallotResult, parts = ["v1", "fake"]) {
    const casts: Array<{ voteId: string; userId: string; choice: VoteChoice }> = [];
    const { interaction, log, replies } = fakeInteraction();
    await casualVoteComponent({
        castBallot: async (_client, voteId, userId, choice) => {
            casts.push({ voteId, userId, choice });
            return result;
        },
    }).handle(interaction as never, parts, client);
    return { casts, log, replies };
}

test("casual-vote: defers first, casts a plain ballot for the clicker, and a recorded ballot says nothing", async () => {
    const { casts, log, replies } = await click({ kind: "ok" });
    expect(casts).toEqual([{ voteId: "v1", userId: "u1", choice: VoteChoice.FAKE }]);
    expect(log).toEqual(["deferUpdate"]);
    expect(replies).toEqual([]);
});

test("casual-vote: every other outcome gets a short private answer", async () => {
    expect((await click({ kind: "finder" })).replies[0]).toContain("your own find");
    expect((await click({ kind: "changed" })).replies[0]).toContain("Vote changed to **Fake**");
    expect((await click({ kind: "unchanged" })).replies[0]).toContain("already voted");
    expect((await click({ kind: "change_locked" })).replies[0]).toContain("can't change again");
    expect((await click({ kind: "not_found" })).replies[0]).toContain("no longer available");
});

test("casual-vote: malformed parts cast nothing", async () => {
    const { casts, replies } = await click({ kind: "ok" }, ["v1", "maybe"]);
    expect(casts).toEqual([]);
    expect(replies[0]).toContain("no longer available");
});
