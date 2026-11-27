import { expect, test } from "bun:test";
import type { GuildCommandContext } from "@/define";
import { runWebhook } from "../commands/webhook.command";
import { getMemberWebhook, regenerateWebhook, type WebhookDeps } from "./webhook.service";

function setup(options: { claim?: boolean; createFails?: boolean; saveFails?: boolean; deleteFails?: boolean } = {}) {
    const calls: string[] = [];
    const user = { id: 1, guild_id: "g", discord_user_id: "me", webhook_regenerated_at: null, flower: null };
    const deps: WebhookDeps = {
        getUserByDiscordId: async () => user as never,
        getUserById: async () => user as never,
        getMacroChannelByUserId: async () => ({ channel_id: "c", webhook_id: "old", webhook_url: "enc:old-url" }) as never,
        claimWebhookRegeneration: async () => (options.claim === false ? null : { previous: null }),
        setWebhookRegeneratedAt: async () => void calls.push("release"),
        replaceMacroWebhook: async (_id, webhookId, url) => {
            if (options.saveFails) throw new Error("db down");
            calls.push(`save ${webhookId} ${url}`);
        },
        registerChannel: (channelId, entry) => void calls.push(`register ${channelId} ${entry.webhookId}`),
        createWebhook: async () => {
            if (options.createFails) throw new Error("no permission");
            calls.push("create");
            return { id: "new", url: "new-url" };
        },
        deleteWebhook: async (id) => {
            calls.push(`delete ${id}`);
            return !options.deleteFails;
        },
        encrypt: (text) => `enc:${text}`,
        decrypt: (text) => text.slice(4),
    };
    return { deps, calls };
}

test("a member gets the webhook of their own channel", async () => {
    const { deps } = setup();
    expect(await getMemberWebhook("g", "me", deps)).toEqual({ userId: 1, channelId: "c", url: "old-url", nextRegenerationAt: null });
});

test("regenerating saves and tracks the new webhook before deleting the old one", async () => {
    const { deps, calls } = setup();
    const result = await regenerateWebhook(1, "me", deps);
    expect(result).toMatchObject({ url: "new-url", oldRemoved: true });
    expect(result.nextRegenerationAt).not.toBeNull();
    expect(calls).toEqual(["create", "save new enc:new-url", "register c new", "delete old"]);
});

test("only the owner can regenerate, and not twice within the cooldown", async () => {
    const stranger = setup();
    await expect(regenerateWebhook(1, "someone", stranger.deps)).rejects.toThrow("isn't yours");
    const again = setup({ claim: false });
    await expect(regenerateWebhook(1, "me", again.deps)).rejects.toThrow("last 24 hours");
    expect([...stranger.calls, ...again.calls]).toEqual([]);
});

test("a failure before the new webhook is saved gives the attempt back and keeps the old one", async () => {
    const create = setup({ createFails: true });
    await expect(regenerateWebhook(1, "me", create.deps)).rejects.toThrow("no permission");
    expect(create.calls).toEqual(["release"]);

    const save = setup({ saveFails: true });
    await expect(regenerateWebhook(1, "me", save.deps)).rejects.toThrow("db down");
    expect(save.calls).toEqual(["create", "delete new", "release"]);
});

test("an old webhook Discord won't delete is reported", async () => {
    const { deps } = setup({ deleteFails: true });
    expect((await regenerateWebhook(1, "me", deps)).oldRemoved).toBe(false);
});

function context(mode: "slash" | "prefix", dmFails = false) {
    const replies: unknown[] = [];
    const dms: unknown[] = [];
    const ctx = {
        mode,
        guild: { id: "g" },
        user: {
            id: "me",
            send: async (payload: unknown) => {
                if (dmFails) throw new Error("closed");
                dms.push(payload);
            },
        },
        defer: async () => {},
        reply: async (payload: unknown) => void replies.push(payload),
    } as unknown as GuildCommandContext;
    return { ctx, replies, dms };
}

test("the URL goes to the ephemeral reply on slash, and only to the DM on prefix", async () => {
    const slash = context("slash");
    await runWebhook(slash.ctx, setup().deps);
    expect(JSON.stringify(slash.replies)).toContain("old-url");
    expect(slash.dms).toEqual([]);

    const prefix = context("prefix");
    await runWebhook(prefix.ctx, setup().deps);
    expect(JSON.stringify(prefix.dms)).toContain("old-url");
    expect(JSON.stringify(prefix.replies)).not.toContain("old-url");

    const closed = context("prefix", true);
    await expect(runWebhook(closed.ctx, setup().deps)).rejects.toThrow("couldn't send you a DM");
    expect(closed.replies).toEqual([]);
});
