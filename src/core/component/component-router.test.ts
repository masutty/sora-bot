import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { MessageFlags } from "discord.js";
import { Logger } from "@/utils/logging";
import { currentTrace } from "@/utils/trace";
import type { BotClient } from "../bot-client";
import {
    type ComponentDefinition, defineComponent, dispatchComponent, matchComponent, validateComponentPrefix,
} from "./component-router";

let logError: ReturnType<typeof spyOn>;

beforeEach(() => {
    logError = spyOn(Logger.prototype, "error").mockImplementation(() => {});
});

afterEach(() => {
    logError.mockRestore();
});

function fakeInteraction(
    customId: string,
    opts: { userId?: string; guildId?: string | null; replied?: boolean; deferred?: boolean } = {},
) {
    const replies: unknown[] = [];
    const interaction = {
        customId,
        user: { id: opts.userId ?? "u1", username: "tester" },
        guildId: opts.guildId ?? "g1",
        replied: opts.replied ?? false,
        deferred: opts.deferred ?? false,
        reply: async (payload: unknown) => { replies.push(payload); },
    };
    return { interaction: interaction as unknown as Parameters<typeof dispatchComponent>[1], replies };
}

function fakeClient(cogs: Record<string, { name: string; components?: ComponentDefinition[] }>): BotClient {
    return { cogs: new Map(Object.entries(cogs)) } as unknown as BotClient;
}

test("defineComponent returns the definition unchanged", () => {
    const handle = async () => {};
    const def = defineComponent({ prefix: "mycog:vote", handle });
    expect(def).toEqual({ prefix: "mycog:vote", handle });
});

test("matchComponent routes a customId that starts with prefix + \":\", splitting the rest into parts", () => {
    const vote = defineComponent({ prefix: "mycog:vote", handle: async () => {} });
    const other = defineComponent({ prefix: "mycog:other", handle: async () => {} });

    const found = matchComponent([other, vote], "mycog:vote:abc123:real");

    expect(found?.component).toBe(vote);
    expect(found?.parts).toEqual(["abc123", "real"]);
});

test("matchComponent routes a legacyIds entry by EXACT customId equality, with empty parts", () => {
    const vote = defineComponent({ prefix: "mycog:vote", legacyIds: ["bh-vote-confirm"], handle: async () => {} });

    const found = matchComponent([vote], "bh-vote-confirm");

    expect(found?.component).toBe(vote);
    expect(found?.parts).toEqual([]);
});

test("matchComponent's legacyIds is exact-match only, never a prefix - trailing segments don't match", () => {
    const vote = defineComponent({ prefix: "mycog:vote", legacyIds: ["bh-vote-confirm"], handle: async () => {} });

    expect(matchComponent([vote], "bh-vote-confirm:extra")).toBeUndefined();
});

test("matchComponent ignores an id that starts with the bare prefix but not prefix + \":\"", () => {
    const vote = defineComponent({ prefix: "mycog:vote", handle: async () => {} });
    expect(matchComponent([vote], "mycog:voteXYZ")).toBeUndefined();
});

test("matchComponent returns undefined for an unknown customId", () => {
    const vote = defineComponent({ prefix: "mycog:vote", handle: async () => {} });
    expect(matchComponent([vote], "othercog:thing:1")).toBeUndefined();
});

test("validateComponentPrefix accepts a prefix starting with the cog's own name", () => {
    expect(() => validateComponentPrefix("mycog", { prefix: "mycog:vote", handle: async () => {} })).not.toThrow();
});

test("validateComponentPrefix rejects a prefix that doesn't start with the cog's own name", () => {
    expect(() => validateComponentPrefix("mycog", { prefix: "othercog:vote", handle: async () => {} })).toThrow();
});

test("dispatchComponent runs handle inside a trace named component:<prefix>, with user/guild", async () => {
    const seen: Array<ReturnType<typeof currentTrace>> = [];
    const vote = defineComponent({
        prefix: "mycog:vote",
        handle: async () => { seen.push(currentTrace()); },
    });
    const client = fakeClient({ mycog: { name: "mycog", components: [vote] } });

    const { interaction } = fakeInteraction("mycog:vote:abc:real", { userId: "u42", guildId: "g9" });
    const handled = await dispatchComponent(client, interaction);

    expect(handled).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.command).toBe("component:mycog:vote");
    expect(seen[0]?.userId).toBe("u42");
    expect(seen[0]?.userTag).toBe("tester");
    expect(seen[0]?.guildId).toBe("g9");
    expect(seen[0]?.ref).toBeTruthy();
});

test("dispatchComponent passes parts and the client through to handle", async () => {
    const calls: unknown[] = [];
    const vote = defineComponent({
        prefix: "mycog:vote",
        handle: async (_interaction, parts, client) => { calls.push([parts, client]); },
    });
    const client = fakeClient({ mycog: { name: "mycog", components: [vote] } });

    const { interaction } = fakeInteraction("mycog:vote:abc:real");
    await dispatchComponent(client, interaction);

    expect(calls).toEqual([[["abc", "real"], client]]);
});

test("dispatchComponent ignores an id no cog's component owns - returns false, calls nothing", async () => {
    const handle = async () => { throw new Error("should not run"); };
    const client = fakeClient({ mycog: { name: "mycog", components: [defineComponent({ prefix: "mycog:vote", handle })] } });

    const { interaction } = fakeInteraction("unknown:thing:1");
    const handled = await dispatchComponent(client, interaction);

    expect(handled).toBe(false);
    expect(logError).not.toHaveBeenCalled();
});

test("dispatchComponent logs (not throws) when handle rejects, and best-effort replies a generic ephemeral failure", async () => {
    const vote = defineComponent({ prefix: "mycog:vote", handle: async () => { throw new Error("boom"); } });
    const client = fakeClient({ mycog: { name: "mycog", components: [vote] } });

    const { interaction, replies } = fakeInteraction("mycog:vote:abc");
    const handled = await dispatchComponent(client, interaction);

    expect(handled).toBe(true);
    expect(logError).toHaveBeenCalledTimes(1);
    expect(replies).toHaveLength(1);
    expect((replies[0] as { flags?: number }).flags).toBe(MessageFlags.Ephemeral);
});

test("dispatchComponent does NOT reply when handle throws after already answering the interaction itself", async () => {
    const vote = defineComponent({
        prefix: "mycog:vote",
        handle: async () => { throw new Error("boom, but only after deferring"); },
    });
    const client = fakeClient({ mycog: { name: "mycog", components: [vote] } });

    const { interaction, replies } = fakeInteraction("mycog:vote:abc", { deferred: true });
    const handled = await dispatchComponent(client, interaction);

    expect(handled).toBe(true);
    expect(logError).toHaveBeenCalledTimes(1);
    expect(replies).toHaveLength(0); // already deferred - a reply() here would throw a second error
});
