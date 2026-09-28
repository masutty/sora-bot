import { describe, expect, test } from "bun:test";
import { type ChatInputCommandInteraction, type Message, MessageFlags } from "discord.js";
import { config } from "@/config";
import { createFakeTransport } from "../view/fake-transport";
import { defineView } from "../view/view";
import { createPrefixContext, createSlashContext } from "./command-context";
import { fakeClient, fakeGuild, fakeInteractionOptions, fakeUser } from "./fakes";
import { PrefixArgs } from "./prefix-args";

type Call = [method: string, arg?: unknown];

function recordingInteraction() {
    const calls: Call[] = [];
    const sent = (id: string) => ({ id, createdTimestamp: 2_000 }) as unknown as Message;
    const interaction = {
        user: fakeUser("1"),
        guild: fakeGuild(),
        member: null,
        createdTimestamp: 1_000,
        options: fakeInteractionOptions({}),
        replied: false,
        deferred: false,
        async reply(arg: unknown) {
            calls.push(["reply", arg]);
            (this as { replied: boolean }).replied = true;
        },
        async fetchReply() {
            calls.push(["fetchReply"]);
            return sent("first");
        },
        async deferReply(arg: unknown) {
            calls.push(["deferReply", arg]);
            (this as { deferred: boolean }).deferred = true;
        },
        async editReply(arg: unknown) {
            calls.push(["editReply", arg]);
            return sent("first");
        },
        async followUp(arg: unknown) {
            calls.push(["followUp", arg]);
            return sent("followup");
        },
    } as unknown as ChatInputCommandInteraction;
    return { interaction, calls };
}

function recordingMessage() {
    const calls: Call[] = [];
    const deleted: string[] = [];
    let n = 0;
    const message = {
        author: fakeUser("1"),
        channel: {
            async sendTyping() {
                calls.push(["sendTyping"]);
            },
        },
        guild: fakeGuild(),
        member: null,
        createdTimestamp: 1_000,
        async reply(arg: unknown) {
            calls.push(["reply", arg]);
            const id = `sent${++n}`;
            return {
                id,
                async delete() {
                    deleted.push(id);
                },
                async edit(e: unknown) {
                    calls.push(["edit", e]);
                },
            } as unknown as Message;
        },
    } as unknown as Message;
    return { message, calls, deleted };
}

const isEphemeral = (arg: unknown) => (((arg as { flags?: number }).flags ?? 0) & MessageFlags.Ephemeral) !== 0;
const methods = (calls: Call[]) => calls.map(([m]) => m);

describe("slash replies", () => {
    test("reply, reply -> reply then followUp (never a second reply)", async () => {
        const { interaction, calls } = recordingInteraction();
        const ctx = createSlashContext(interaction, fakeClient());
        await ctx.reply("a");
        await ctx.reply("b");
        expect(methods(calls)).toEqual(["reply", "fetchReply", "followUp"]);
    });

    test("defer, reply, reply -> deferReply, editReply, followUp", async () => {
        const { interaction, calls } = recordingInteraction();
        const ctx = createSlashContext(interaction, fakeClient());
        await ctx.defer();
        await ctx.reply("a");
        await ctx.reply("b");
        expect(methods(calls)).toEqual(["deferReply", "editReply", "followUp"]);
    });

    test("defer({ephemeral}) makes later followUps ephemeral too", async () => {
        const { interaction, calls } = recordingInteraction();
        const ctx = createSlashContext(interaction, fakeClient());
        await ctx.defer({ ephemeral: true });
        await ctx.reply("a");
        await ctx.reply("b");
        expect(isEphemeral(calls[0][1])).toBe(true);
        expect(isEphemeral(calls[2][1])).toBe(true);
    });

    test("an ephemeral reply keeps a ComponentsV2 flag it already had", async () => {
        const { interaction, calls } = recordingInteraction();
        const ctx = createSlashContext(interaction, fakeClient());
        await ctx.reply({ components: [], flags: MessageFlags.IsComponentsV2 }, { ephemeral: true });
        const flags = (calls[0][1] as { flags: number }).flags;
        expect(flags & MessageFlags.IsComponentsV2).toBeTruthy();
        expect(flags & MessageFlags.Ephemeral).toBeTruthy();
    });

    test("editReply edits the original response", async () => {
        const { interaction, calls } = recordingInteraction();
        const ctx = createSlashContext(interaction, fakeClient());
        await ctx.reply("a");
        await ctx.editReply("b");
        expect(methods(calls)).toEqual(["reply", "fetchReply", "editReply"]);
    });

    test("invokePrefix is '/'", () => {
        expect(createSlashContext(recordingInteraction().interaction, fakeClient()).invokePrefix).toBe("/");
    });
});

describe("prefix replies", () => {
    const prefixArgs = () => new PrefixArgs([], [], null, fakeClient());

    test("defer only shows typing; reply -> message.reply", async () => {
        const { message, calls } = recordingMessage();
        const ctx = createPrefixContext(message, prefixArgs(), fakeClient(), "!", { schedule: () => {} });
        await ctx.defer();
        await ctx.reply("a");
        expect(methods(calls)).toEqual(["sendTyping", "reply"]);
    });

    test("an ephemeral reply is deleted after config.ui.prefixEphemeralTtlMs", async () => {
        const { message, deleted } = recordingMessage();
        const scheduled: Array<[() => void, number]> = [];
        const ctx = createPrefixContext(message, prefixArgs(), fakeClient(), "!", { schedule: (fn, ms) => scheduled.push([fn, ms]) });
        await ctx.reply("secret", { ephemeral: true });
        expect(scheduled).toHaveLength(1);
        expect(scheduled[0][1]).toBe(config.ui.prefixEphemeralTtlMs);
        expect(deleted).toEqual([]);
        scheduled[0][0]();
        await Promise.resolve();
        expect(deleted).toEqual(["sent1"]);
    });

    test("defer({ephemeral:true}) makes later replies ephemeral", async () => {
        const { message } = recordingMessage();
        const scheduled: number[] = [];
        const ctx = createPrefixContext(message, prefixArgs(), fakeClient(), "!", { schedule: (_fn, ms) => scheduled.push(ms) });
        await ctx.defer({ ephemeral: true });
        await ctx.reply("a");
        await ctx.reply("b");
        expect(scheduled).toHaveLength(2);
    });

    test("a non-ephemeral reply schedules nothing", async () => {
        const { message } = recordingMessage();
        const scheduled: number[] = [];
        const ctx = createPrefixContext(message, prefixArgs(), fakeClient(), "!", { schedule: (_fn, ms) => scheduled.push(ms) });
        await ctx.reply("a");
        expect(scheduled).toEqual([]);
    });

    test("editReply edits the first sent message; invokePrefix is the guild prefix", async () => {
        const { message, calls } = recordingMessage();
        const ctx = createPrefixContext(message, prefixArgs(), fakeClient(), "?", { schedule: () => {} });
        await ctx.reply("a");
        await ctx.editReply("b");
        expect(methods(calls)).toEqual(["reply", "edit"]);
        expect(ctx.invokePrefix).toBe("?");
    });
});

describe("review fixes", () => {
    test("slash: if run already replied through ctx.raw, the next ctx.reply follows up", async () => {
        const { interaction, calls } = recordingInteraction();
        const ctx = createSlashContext(interaction, fakeClient());
        await interaction.reply({ content: "direct" });
        await ctx.reply("a");
        expect(methods(calls)).toEqual(["reply", "followUp"]);
    });

    test("prefix: a per-reply ttlMs overrides the configured TTL", async () => {
        const { message } = recordingMessage();
        const scheduled: number[] = [];
        const ctx = createPrefixContext(message, new PrefixArgs([], [], null, fakeClient()), fakeClient(), "!", {
            schedule: (_fn, ms) => scheduled.push(ms),
        });
        await ctx.reply("a", { ephemeral: true, ttlMs: 300_000 });
        expect(scheduled).toEqual([300_000]);
    });

    test("prefix: defer shows the typing indicator", async () => {
        const { message, calls } = recordingMessage();
        const ctx = createPrefixContext(message, new PrefixArgs([], [], null, fakeClient()), fakeClient(), "!", { schedule: () => {} });
        await ctx.defer();
        expect(methods(calls)).toEqual(["sendTyping"]);
    });

    test("replyUsage replies with the usage the framework supplied", async () => {
        const { message, calls } = recordingMessage();
        const usage = { components: [], flags: MessageFlags.IsComponentsV2 } as const;
        const ctx = createPrefixContext(message, new PrefixArgs([], [], null, fakeClient()), fakeClient(), "!", {
            schedule: () => {},
            usage: () => usage,
        });
        await ctx.replyUsage();
        expect(calls[0]).toEqual(["reply", usage]);
    });
});

describe("ctx.open", () => {
    const view = defineView<null, void>({
        name: "test.view",
        initial: () => null,
        render: (_s, kit) => ({ content: "v", components: [kit.row(kit.button("ok", (b) => b.setLabel("x")))] }),
        on: { ok: (c) => c.done() },
    });

    test("prefix: an ephemeral View is deleted a TTL after the session ends, not after the first send", async () => {
        const { message, calls, deleted } = recordingMessage();
        const scheduled: Array<[() => void, number]> = [];
        const fake = createFakeTransport();
        const ctx = createPrefixContext(message, new PrefixArgs([], [], null, fakeClient()), fakeClient(), "!", {
            schedule: (fn, ms) => scheduled.push([fn, ms]),
            viewTransport: () => fake,
        });

        const run = ctx.open(view, undefined, { ephemeral: true, ttlMs: 30_000 });
        await fake.flush();
        expect(methods(calls)).toEqual(["reply"]);
        expect(scheduled).toEqual([]);

        fake.responded.push(calls[0][1] as never);
        await fake.emit(fake.click("ok", "1"));
        await run;

        expect(scheduled.map(([, ms]) => ms)).toEqual([30_000]);
        expect(deleted).toEqual([]);
        scheduled[0][0]();
        await Promise.resolve();
        expect(deleted).toEqual(["sent1"]);
    });
});

test("onFirstReply fires once, after the first reply is sent (the command log's 'replied in')", async () => {
    const { message } = recordingMessage();
    let fired = 0;
    const ctx = createPrefixContext(message, new PrefixArgs([], [], null, fakeClient()), fakeClient(), "!", {
        schedule: () => {},
        onFirstReply: () => fired++,
    });
    await ctx.defer();
    expect(fired).toBe(0);
    await ctx.reply("a");
    await ctx.reply("b");
    expect(fired).toBe(1);
});
