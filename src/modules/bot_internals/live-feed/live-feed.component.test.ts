import { expect, test } from "bun:test";
import { MessageFlags } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { type LiveFeedComponentDeps, liveFeedComponent } from "./live-feed.component";
import { buildClosedPayload } from "./render";

function fakeInteraction(userId: string) {
    const log: string[] = [];
    const replies: Array<Record<string, unknown>> = [];
    const updates: unknown[] = [];
    const interaction = {
        user: { id: userId },
        isButton: () => true,
        reply: async (p: Record<string, unknown>) => {
            log.push("reply");
            replies.push(p);
        },
        update: async (p: unknown) => {
            log.push("update");
            updates.push(p);
        },
        deferUpdate: async () => {
            log.push("deferUpdate");
        },
    };
    return { interaction, log, replies, updates };
}

function fakeDeps(overrides: Partial<LiveFeedComponentDeps> = {}) {
    const calls: string[] = [];
    let bufferCalls = 0;
    const deps: LiveFeedComponentDeps = {
        ownerIds: () => ["o1"],
        feed: {
            activeId: () => "f1",
            extend: async (id) => {
                calls.push(`extend:${id}`);
                return true;
            },
            stop: async (id, reason) => {
                calls.push(`stop:${id}:${reason}`);
                return true;
            },
        },
        bufferText: () => {
            bufferCalls++;
            return "raw line 1\nraw line 2";
        },
        ...overrides,
    };
    return { deps, calls, bufferCalls: () => bufferCalls };
}

const client = {} as BotClient;

test("live-feed component: a non-owner buffer click gets no files and never reads the buffer", async () => {
    const { deps, bufferCalls } = fakeDeps();
    const { interaction, replies } = fakeInteraction("someone");
    await liveFeedComponent(deps).handle(interaction as never, ["f1", "buffer"], client);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.files).toBeUndefined();
    expect(replies[0]?.flags).toBe(MessageFlags.Ephemeral);
    expect(bufferCalls()).toBe(0);
});

test("live-feed component: ownerIds throwing denies the click", async () => {
    const { deps, bufferCalls, calls } = fakeDeps({
        ownerIds: () => {
            throw new Error("config broke");
        },
    });
    const { interaction, replies } = fakeInteraction("o1");
    await liveFeedComponent(deps).handle(interaction as never, ["f1", "buffer"], client);
    expect(replies[0]?.files).toBeUndefined();
    expect(bufferCalls()).toBe(0);
    expect(calls).toHaveLength(0);
});

test("live-feed component: an owner click on a stale feed id closes the message", async () => {
    const { deps, calls } = fakeDeps();
    const { interaction, updates } = fakeInteraction("o1");
    await liveFeedComponent(deps).handle(interaction as never, ["old", "stop"], client);
    expect(updates).toEqual([buildClosedPayload("closed")]);
    expect(calls).toHaveLength(0);
});

test("live-feed component: an owner buffer click replies with the raw text as a .txt file", async () => {
    const { deps } = fakeDeps();
    const { interaction, replies } = fakeInteraction("o1");
    await liveFeedComponent(deps).handle(interaction as never, ["f1", "buffer"], client);
    const files = replies[0]?.files as Array<{ attachment: Buffer; name: string }>;
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toMatch(/^sora-log-buffer-.+\.txt$/);
    expect(files[0]?.attachment.toString()).toBe("raw line 1\nraw line 2");
    expect(replies[0]?.flags).toBe(MessageFlags.Ephemeral);
});

test("live-feed component: an owner extend click defers then extends", async () => {
    const { deps, calls } = fakeDeps();
    const { interaction, log } = fakeInteraction("o1");
    await liveFeedComponent(deps).handle(interaction as never, ["f1", "extend"], client);
    expect(log).toEqual(["deferUpdate"]);
    expect(calls).toEqual(["extend:f1"]);
});

test("live-feed component: an owner stop click defers then stops", async () => {
    const { deps, calls } = fakeDeps();
    const { interaction, log } = fakeInteraction("o1");
    await liveFeedComponent(deps).handle(interaction as never, ["f1", "stop"], client);
    expect(log).toEqual(["deferUpdate"]);
    expect(calls).toEqual(["stop:f1:stopped"]);
});

test("live-feed component: an unknown action only defers", async () => {
    const { deps, calls } = fakeDeps();
    const { interaction, log } = fakeInteraction("o1");
    await liveFeedComponent(deps).handle(interaction as never, ["f1", "wat"], client);
    expect(log).toEqual(["deferUpdate"]);
    expect(calls).toHaveLength(0);
});
