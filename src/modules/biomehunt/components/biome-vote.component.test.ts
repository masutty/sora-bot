import { expect, test } from "bun:test";
import type { BotClient } from "@/core/bot-client";
import { VoteChoice, VoteStatus } from "../types";
import { type BiomeVoteComponentDeps, biomeVoteComponent } from "./biome-vote.component";

const client = {} as BotClient;

function fakeInteraction(opts: { isAdmin?: boolean; userId?: string } = {}) {
    const replies: unknown[] = [];
    const deferUpdates: number[] = [];
    const interaction = {
        isButton: () => true,
        user: { id: opts.userId ?? "u1" },
        member: { permissions: { has: () => opts.isAdmin ?? false } },
        reply: async (payload: unknown) => { replies.push(payload); },
        deferUpdate: async () => { deferUpdates.push(1); },
    };
    return { interaction, replies, deferUpdates };
}

function fakeDeps(overrides: Partial<BiomeVoteComponentDeps> = {}): BiomeVoteComponentDeps {
    return {
        castBallot: async () => ({ kind: "ok" }),
        adminDecide: async () => ({ kind: "ok", status: VoteStatus.ADMIN_CONFIRMED }),
        ...overrides,
    };
}

test("ignores an interaction that isn't a button", async () => {
    const component = biomeVoteComponent(fakeDeps());
    const interaction = { isButton: () => false };

    await component.handle(interaction as never, ["vote1", "real"], client);
    // No throw = pass; nothing to assert since it returns immediately.
    expect(true).toBe(true);
});

test("ignores malformed parts (missing voteId or an unknown choice)", async () => {
    const calls: string[] = [];
    const component = biomeVoteComponent(fakeDeps({
        castBallot: async () => { calls.push("castBallot"); return { kind: "ok" }; },
    }));
    const { interaction } = fakeInteraction();

    await component.handle(interaction as never, [], client);
    await component.handle(interaction as never, ["vote1", "maybe"], client);

    expect(calls).toHaveLength(0);
});

test("a non-admin click calls castBallot with the real/fake choice parsed from parts", async () => {
    const seen: unknown[] = [];
    const component = biomeVoteComponent(fakeDeps({
        castBallot: async (_client, voteId, userId, choice) => { seen.push([voteId, userId, choice]); return { kind: "ok" }; },
    }));
    const { interaction, deferUpdates } = fakeInteraction({ isAdmin: false, userId: "voter-1" });

    await component.handle(interaction as never, ["vote1", "fake"], client);

    expect(seen).toEqual([["vote1", "voter-1", VoteChoice.FAKE]]);
    expect(deferUpdates).toHaveLength(1);
});

test("an admin click calls adminDecide instead of castBallot", async () => {
    const adminCalls: unknown[] = [];
    const ballotCalls: unknown[] = [];
    const component = biomeVoteComponent(fakeDeps({
        adminDecide: async (_client, voteId, adminId, choice) => { adminCalls.push([voteId, adminId, choice]); return { kind: "ok", status: VoteStatus.ADMIN_DENIED }; },
        castBallot: async () => { ballotCalls.push(1); return { kind: "ok" }; },
    }));
    const { interaction, deferUpdates } = fakeInteraction({ isAdmin: true, userId: "admin-1" });

    await component.handle(interaction as never, ["vote1", "real"], client);

    expect(adminCalls).toEqual([["vote1", "admin-1", VoteChoice.REAL]]);
    expect(ballotCalls).toHaveLength(0);
    expect(deferUpdates).toHaveLength(1);
});

test("castBallot 'finder' answers ephemeral \"You can't vote on your own find.\"", async () => {
    const component = biomeVoteComponent(fakeDeps({ castBallot: async () => ({ kind: "finder" }) }));
    const { interaction, replies } = fakeInteraction();

    await component.handle(interaction as never, ["vote1", "real"], client);

    expect(replies).toEqual([{ content: "You can't vote on your own find.", ephemeral: true }]);
});

test("castBallot 'already_voted' answers ephemeral \"You already voted.\"", async () => {
    const component = biomeVoteComponent(fakeDeps({ castBallot: async () => ({ kind: "already_voted" }) }));
    const { interaction, replies } = fakeInteraction();

    await component.handle(interaction as never, ["vote1", "real"], client);

    expect(replies).toEqual([{ content: "You already voted.", ephemeral: true }]);
});

test("castBallot 'not_found'/'closed' answer ephemeral \"This vote is no longer available.\"", async () => {
    for (const kind of ["not_found", "closed"] as const) {
        const component = biomeVoteComponent(fakeDeps({ castBallot: async () => ({ kind }) }));
        const { interaction, replies } = fakeInteraction();

        await component.handle(interaction as never, ["vote1", "real"], client);

        expect(replies).toEqual([{ content: "This vote is no longer available.", ephemeral: true }]);
    }
});

test("adminDecide 'not_found' answers ephemeral \"This vote is no longer available.\"", async () => {
    const component = biomeVoteComponent(fakeDeps({ adminDecide: async () => ({ kind: "not_found" }) }));
    const { interaction, replies, deferUpdates } = fakeInteraction({ isAdmin: true });

    await component.handle(interaction as never, ["vote1", "real"], client);

    expect(replies).toEqual([{ content: "This vote is no longer available.", ephemeral: true }]);
    expect(deferUpdates).toHaveLength(0);
});
