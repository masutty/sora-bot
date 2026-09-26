import { expect, test } from "bun:test";
import { type Message, MessageFlags } from "discord.js";
import { createDiscordTransport } from "./discord-transport";
import type { ComponentEvent } from "./view-engine";

/** Just the Message members the transport touches; `edit` records (or 404s, like an ephemeral message would). */
function fakeMessage(opts: { ephemeral?: boolean } = {}) {
    const edits: unknown[] = [];
    const message = {
        id: "m1",
        flags: { has: (f: number) => f === MessageFlags.Ephemeral && (opts.ephemeral ?? false) },
        edit: async (p: unknown) => {
            if (opts.ephemeral) throw new Error("Unknown Message");
            edits.push(p);
        },
    };
    return { message: message as unknown as Message, edits };
}

function seeded() {
    const calls: { message: Message; payload: unknown }[] = [];
    return { calls, editMessage: async (message: Message, payload: unknown) => void calls.push({ message, payload }) };
}

type Fn = (...args: unknown[]) => Promise<unknown>;

function click(overrides: Record<string, Fn> = {}) {
    const calls: string[] = [];
    const rec = (name: string): Fn => async () => void calls.push(name);
    const raw = {
        user: { id: "u1" },
        update: rec("update"),
        deferUpdate: rec("deferUpdate"),
        editReply: rec("editReply"),
        reply: rec("reply"),
        followUp: rec("followUp"),
        showModal: rec("showModal"),
        ...overrides,
    };
    const e: ComponentEvent = { kind: "component", customId: "v:1:k", userId: "u1", values: [], raw };
    return { e, calls };
}

const spec = { title: "t", fields: [{ key: "a", label: "A" }] };

test("ephemeral View, no clicks yet: render(null) (e.g. expiry) goes through the seeded editor", async () => {
    const { message } = fakeMessage({ ephemeral: true });
    const editor = seeded();
    const t = createDiscordTransport(message, { editMessage: editor.editMessage });
    await t.render(null, { content: "expired" });
    expect(editor.calls).toEqual([{ message, payload: { content: "expired" } }]);
});

test("ephemeral View, first click gets a notify then a redraw: the redraw uses the seeded editor, not message.edit", async () => {
    const { message } = fakeMessage({ ephemeral: true });
    const editor = seeded();
    const t = createDiscordTransport(message, { editMessage: editor.editMessage });
    const { e, calls } = click();
    await t.notify(e, "invalid");
    await t.render(e, { content: "again" });
    expect(calls).toEqual(["reply"]);
    expect(editor.calls).toHaveLength(1);
});

test("ephemeral View: a newer click token that edits the message wins over the seeded editor", async () => {
    const { message } = fakeMessage({ ephemeral: true });
    const editor = seeded();
    const t = createDiscordTransport(message, { editMessage: editor.editMessage });
    const first = click();
    await t.render(first.e, { content: "a" });
    await t.render(null, { content: "b" });
    expect(first.calls).toEqual(["update", "editReply"]);
    expect(editor.calls).toHaveLength(0);
});

test("non-ephemeral View: render(null) edits the message itself (no token expiry)", async () => {
    const { message, edits } = fakeMessage();
    const editor = seeded();
    const t = createDiscordTransport(message, { editMessage: editor.editMessage });
    await t.render(null, { content: "x" });
    expect(edits).toEqual([{ content: "x" }]);
    expect(editor.calls).toHaveLength(0);
});

test("modal: a showModal failure rejects (the engine logs it) and the click still gets acknowledged", async () => {
    const { message } = fakeMessage();
    const t = createDiscordTransport(message);
    const { e, calls } = click({
        showModal: async () => {
            throw new Error("Invalid Form Body");
        },
    });
    await expect(t.modal(e, spec, "v:1:modal:1", 1_000)).rejects.toThrow("Invalid Form Body");
    expect(calls).toEqual(["deferUpdate"]);
});

test("modal: an invalid spec rejects before showing anything, and the click still gets acknowledged", async () => {
    const { message } = fakeMessage();
    const t = createDiscordTransport(message);
    const { e, calls } = click();
    await expect(t.modal(e, { title: "t", fields: [{ key: "a", label: "A", maxLength: 0 }] }, "v:1:modal:1", 1_000)).rejects.toThrow();
    expect(calls).toEqual(["deferUpdate"]);
});

test("modal: an awaitModalSubmit timeout resolves null", async () => {
    const { message } = fakeMessage();
    const t = createDiscordTransport(message);
    const { e } = click({
        awaitModalSubmit: async () => {
            throw new Error("Collector received no interactions before ending with reason: time");
        },
    });
    expect(await t.modal(e, spec, "v:1:modal:1", 1_000)).toBeNull();
});

test("acknowledge and component notify reject on a Discord error while open, and are swallowed after close", async () => {
    const { message } = fakeMessage();
    const t = createDiscordTransport(message);
    const failing = () =>
        click({
            deferUpdate: async () => {
                throw new Error("Unknown interaction");
            },
            reply: async () => {
                throw new Error("Unknown interaction");
            },
        }).e;
    await expect(t.acknowledge(failing())).rejects.toThrow("Unknown interaction");
    await expect(t.notify(failing(), "x")).rejects.toThrow("Unknown interaction");
    t.close();
    await t.acknowledge(failing());
    await t.notify(failing(), "x");
});
