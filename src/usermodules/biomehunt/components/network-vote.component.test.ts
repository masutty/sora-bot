import { expect, test } from "bun:test";
import type { BotClient } from "@/core/bot-client";
import type { CastNetworkBallotResult } from "../services/network-vote.service";
import { VoteChoice } from "../types";
import { type NetworkVoteComponentDeps, networkVoteComponent } from "./network-vote.component";

function fakeInteraction(guildId: string | null, opts: { userId?: string; admin?: boolean } = {}) {
    const log: string[] = [];
    const replies: string[] = [];
    const interaction = {
        user: { id: opts.userId ?? "u1" },
        guildId,
        memberPermissions: { has: () => opts.admin ?? false },
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
    const casts: Array<{ postId: string; userId: string; guildId: string; choice: VoteChoice; canVoteOnOwnFind: boolean }> = [];
    const decisions: Array<{ postId: string; ownerId: string; choice: VoteChoice }> = [];
    const deps: NetworkVoteComponentDeps = {
        cast: async (_client, postId, userId, guildId, choice, canVoteOnOwnFind) => {
            casts.push({ postId, userId, guildId, choice, canVoteOnOwnFind });
            return result;
        },
        decide: async (_client, postId, ownerId, choice) => {
            decisions.push({ postId, ownerId, choice });
            return "ok";
        },
        ownerIds: () => ["owner"],
    };
    return { deps, casts, decisions };
}

const client = {} as BotClient;
const board = { real: 2, fake: 1 };

test("net-vote: a click casts for the clicked server and answers privately with the scoreboard", async () => {
    const { deps, casts } = fakeDeps({ kind: "ok", scoreboard: board });
    const { interaction, log, replies } = fakeInteraction("gB");
    await networkVoteComponent(deps).handle(interaction as never, ["p1", "fake"], client);
    expect(casts).toEqual([{ postId: "p1", userId: "u1", guildId: "gB", choice: VoteChoice.FAKE, canVoteOnOwnFind: false }]);
    expect(log).toEqual(["deferReply", "editReply"]);
    expect(replies[0]).toContain("Vote recorded");
    expect(replies[0]).toContain("✅ Real **2** · ❌ Fake **1**");
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

test("net-vote: an admin's click is a ballot that may be on their own find", async () => {
    const { deps, casts } = fakeDeps({ kind: "ok", scoreboard: board });
    await networkVoteComponent(deps).handle(fakeInteraction("gB", { admin: true }).interaction as never, ["p1", "real"], client);
    expect(casts[0].canVoteOnOwnFind).toBe(true);
});

test("net-vote: the bot owner's click decides the vote instead of casting a ballot", async () => {
    const { deps, casts, decisions } = fakeDeps({ kind: "ok", scoreboard: board });
    const { interaction, replies } = fakeInteraction("gB", { userId: "owner" });
    await networkVoteComponent(deps).handle(interaction as never, ["p1", "fake"], client);
    expect(casts).toHaveLength(0);
    expect(decisions).toEqual([{ postId: "p1", ownerId: "owner", choice: VoteChoice.FAKE }]);
    expect(replies[0]).toContain("marked as **Fake**");
});

test("net-vote: a switch, a repeat and a second switch each get their own answer", async () => {
    const answers: string[] = [];
    for (const kind of ["changed", "unchanged", "change_locked"] as const) {
        const { interaction, replies } = fakeInteraction("gB");
        await networkVoteComponent(fakeDeps({ kind, scoreboard: board }).deps).handle(interaction as never, ["p1", "real"], client);
        answers.push(replies[0]);
    }
    expect(answers[0]).toContain("Vote changed to **Real**");
    expect(answers[1]).toContain("You already voted **Real**");
    expect(answers[2]).toContain("can't change again");
});
