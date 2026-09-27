import { expect, test } from "bun:test";
import { MessageFlags } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { VoteChoice, VoteStatus } from "../types";
import { type BiomeVoteComponentDeps, biomeVoteComponent } from "./biome-vote.component";

const client = {} as BotClient;

/** `order` (shared with the deps below, when a test cares about sequencing) records every call in the order it actually happened. */
function fakeInteraction(opts: { isAdmin?: boolean; userId?: string; order?: string[] } = {}) {
    const followUps: unknown[] = [];
    const deferUpdates: number[] = [];
    const order = opts.order ?? [];
    const interaction = {
        isButton: () => true,
        user: { id: opts.userId ?? "u1" },
        member: { permissions: { has: () => opts.isAdmin ?? false } },
        deferUpdate: async () => { order.push("deferUpdate"); deferUpdates.push(1); },
        followUp: async (payload: unknown) => { followUps.push(payload); },
    };
    return { interaction, followUps, deferUpdates, order };
}

function fakeDeps(overrides: Partial<BiomeVoteComponentDeps> = {}): BiomeVoteComponentDeps {
    return {
        castBallot: async () => ({ kind: "ok" }),
        adminDecide: async () => ({ kind: "ok", status: VoteStatus.ADMIN_CONFIRMED }),
        ...overrides,
    };
}

const EPHEMERAL = (content: string) => ({ content, flags: MessageFlags.Ephemeral });

test("ignores an interaction that isn't a button", async () => {
    const component = biomeVoteComponent(fakeDeps());
    const interaction = { isButton: () => false };

    await component.handle(interaction as never, ["vote1", "real"], client);
    // No throw = pass; nothing to assert since it returns immediately.
    expect(true).toBe(true);
});

test("deferUpdate() happens FIRST, before castBallot ever runs - must ack within Discord's 3s deadline regardless of how slow the DB work is", async () => {
    const order: string[] = [];
    const component = biomeVoteComponent(fakeDeps({
        castBallot: async () => { order.push("castBallot"); return { kind: "ok" }; },
    }));
    const { interaction } = fakeInteraction({ order });

    await component.handle(interaction as never, ["vote1", "real"], client);

    expect(order).toEqual(["deferUpdate", "castBallot"]);
});

test("deferUpdate() happens FIRST for the admin path too, before adminDecide ever runs", async () => {
    const order: string[] = [];
    const component = biomeVoteComponent(fakeDeps({
        adminDecide: async () => { order.push("adminDecide"); return { kind: "ok", status: VoteStatus.ADMIN_CONFIRMED }; },
    }));
    const { interaction } = fakeInteraction({ isAdmin: true, order });

    await component.handle(interaction as never, ["vote1", "real"], client);

    expect(order).toEqual(["deferUpdate", "adminDecide"]);
});

test("a legacyIds match (empty parts - bh-vote-confirm/bh-vote-deny) followUps ephemeral \"This vote is no longer available.\", without calling castBallot/adminDecide", async () => {
    const calls: string[] = [];
    const component = biomeVoteComponent(fakeDeps({
        castBallot: async () => { calls.push("castBallot"); return { kind: "ok" }; },
        adminDecide: async () => { calls.push("adminDecide"); return { kind: "ok", status: VoteStatus.ADMIN_CONFIRMED }; },
    }));
    const { interaction, followUps } = fakeInteraction();

    await component.handle(interaction as never, [], client);

    expect(calls).toHaveLength(0);
    expect(followUps).toEqual([EPHEMERAL("This vote is no longer available.")]);
});

test("malformed parts (an unknown choice segment) are treated the same as a legacy match", async () => {
    const calls: string[] = [];
    const component = biomeVoteComponent(fakeDeps({
        castBallot: async () => { calls.push("castBallot"); return { kind: "ok" }; },
    }));
    const { interaction, followUps } = fakeInteraction();

    await component.handle(interaction as never, ["vote1", "maybe"], client);

    expect(calls).toHaveLength(0);
    expect(followUps).toEqual([EPHEMERAL("This vote is no longer available.")]);
});

test("a non-admin click calls castBallot with the real/fake choice parsed from parts", async () => {
    const seen: unknown[] = [];
    const component = biomeVoteComponent(fakeDeps({
        castBallot: async (_client, voteId, userId, choice) => { seen.push([voteId, userId, choice]); return { kind: "ok" }; },
    }));
    const { interaction, deferUpdates, followUps } = fakeInteraction({ isAdmin: false, userId: "voter-1" });

    await component.handle(interaction as never, ["vote1", "fake"], client);

    expect(seen).toEqual([["vote1", "voter-1", VoteChoice.FAKE]]);
    expect(deferUpdates).toHaveLength(1);
    expect(followUps).toHaveLength(0); // "ok" needs no extra message - the vote message itself was already updated
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

test("castBallot 'finder' followUps ephemeral \"You can't vote on your own find.\"", async () => {
    const component = biomeVoteComponent(fakeDeps({ castBallot: async () => ({ kind: "finder" }) }));
    const { interaction, followUps } = fakeInteraction();

    await component.handle(interaction as never, ["vote1", "real"], client);

    expect(followUps).toEqual([EPHEMERAL("You can't vote on your own find.")]);
});

test("castBallot 'already_voted' followUps ephemeral \"You already voted.\"", async () => {
    const component = biomeVoteComponent(fakeDeps({ castBallot: async () => ({ kind: "already_voted" }) }));
    const { interaction, followUps } = fakeInteraction();

    await component.handle(interaction as never, ["vote1", "real"], client);

    expect(followUps).toEqual([EPHEMERAL("You already voted.")]);
});

test("castBallot 'not_found' followUps ephemeral \"This vote is no longer available.\"", async () => {
    const component = biomeVoteComponent(fakeDeps({ castBallot: async () => ({ kind: "not_found" }) }));
    const { interaction, followUps } = fakeInteraction();

    await component.handle(interaction as never, ["vote1", "real"], client);

    expect(followUps).toEqual([EPHEMERAL("This vote is no longer available.")]);
});

test("castBallot 'closed' followUps ephemeral \"This vote is already closed.\"", async () => {
    const component = biomeVoteComponent(fakeDeps({ castBallot: async () => ({ kind: "closed" }) }));
    const { interaction, followUps } = fakeInteraction();

    await component.handle(interaction as never, ["vote1", "real"], client);

    expect(followUps).toEqual([EPHEMERAL("This vote is already closed.")]);
});

test("adminDecide 'not_found' followUps ephemeral \"This vote is no longer available.\"", async () => {
    const component = biomeVoteComponent(fakeDeps({ adminDecide: async () => ({ kind: "not_found" }) }));
    const { interaction, followUps, deferUpdates } = fakeInteraction({ isAdmin: true });

    await component.handle(interaction as never, ["vote1", "real"], client);

    expect(followUps).toEqual([EPHEMERAL("This vote is no longer available.")]);
    expect(deferUpdates).toHaveLength(1); // still acked immediately - only the follow-up differs
});

test("adminDecide 'already_decided' followUps ephemeral \"This vote was already decided.\"", async () => {
    const component = biomeVoteComponent(fakeDeps({ adminDecide: async () => ({ kind: "already_decided" }) }));
    const { interaction, followUps } = fakeInteraction({ isAdmin: true });

    await component.handle(interaction as never, ["vote1", "real"], client);

    expect(followUps).toEqual([EPHEMERAL("This vote was already decided.")]);
});

