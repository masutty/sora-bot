import { expect, test } from "bun:test";
import type { Client } from "discord.js";
import { defaultEditorDeps } from "./panel-editor.view";

const emoji = (name: string, id: string) => ({ id, name, toString: () => `<:${name}:${id}>` });

const HERE = emoji("tragedy", "100000000000000001");
const ELSEWHERE = emoji("secret", "200000000000000002");
const NEW_HERE = emoji("fresh", "300000000000000003");

const cacheOf = (items: ReturnType<typeof emoji>[]) =>
    Object.assign(new Map(items.map((e) => [e.id, e])), { find: (fn: (e: ReturnType<typeof emoji>) => boolean) => items.find(fn) });

/** A bot in two servers; "g1" (the current one) also has an emoji made after the bot started, which only a fetch finds. */
function fakeClient(): Client {
    const g1 = {
        cache: cacheOf([HERE]),
        fetch: async (id?: string) => {
            if (!id) return cacheOf([HERE, NEW_HERE]);
            return [HERE, NEW_HERE].find((e) => e.id === id) ?? Promise.reject(new Error("Unknown Emoji"));
        },
    };
    return {
        guilds: { cache: new Map([["g1", { emojis: g1 }]]) },
        emojis: { cache: cacheOf([HERE, ELSEWHERE]) },
    } as unknown as Client;
}

test("a custom emoji of any server the bot is in can be used by id", async () => {
    const deps = defaultEditorDeps(fakeClient(), "g1");
    expect(await deps.hasCustomEmoji(HERE.id)).toBe(true);
    expect(await deps.hasCustomEmoji(ELSEWHERE.id)).toBe(true);
    expect(await deps.hasCustomEmoji("999999999999999999")).toBe(false);
});

test("an emoji this server made after the bot started is found by asking Discord, not by the cache", async () => {
    const deps = defaultEditorDeps(fakeClient(), "g1");
    expect(await deps.hasCustomEmoji(NEW_HERE.id)).toBe(true);
    expect(await deps.findCustomEmoji("fresh")).toBe(NEW_HERE.toString());
});

test(":name: only looks in the current server", async () => {
    const deps = defaultEditorDeps(fakeClient(), "g1");
    expect(await deps.findCustomEmoji("tragedy")).toBe(HERE.toString());
    expect(await deps.findCustomEmoji("secret")).toBeNull();
});
