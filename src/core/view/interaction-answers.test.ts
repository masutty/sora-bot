import { expect, test } from "bun:test";
import { MessageFlags } from "discord.js";
import { type Answerable, createInteractionAnswers } from "./interaction-answers";

/** A fake interaction whose calls resolve only when the test releases them, to exercise the in-flight windows. */
function fakeInteraction(opts: { fromMessage?: boolean; manual?: boolean } = {}) {
    const calls: string[] = [];
    const bodies: unknown[] = [];
    const releases: (() => void)[] = [];
    const call = (name: string) => async (body?: unknown) => {
        calls.push(name);
        bodies.push(body);
        if (opts.manual) await new Promise<void>((r) => releases.push(r));
    };
    const i: Answerable & { calls: string[]; bodies: unknown[]; release(): void } = {
        update: call("update"),
        deferUpdate: call("deferUpdate"),
        editReply: call("editReply"),
        reply: call("reply"),
        followUp: call("followUp"),
        showModal: call("showModal"),
        calls,
        bodies,
        release: () => releases.shift()?.(),
    };
    if (opts.fromMessage !== undefined) i.isFromMessage = () => opts.fromMessage as boolean;
    return i;
}

const settle = () => new Promise<void>((r) => setImmediate(r));

function editRecorder() {
    const edits: unknown[] = [];
    return { edits, edit: async (p: unknown) => void edits.push(p) };
}

test("render on an unanswered click updates it; a second render for it edits the reply", async () => {
    const answers = createInteractionAnswers();
    const i = fakeInteraction();
    const { edits, edit } = editRecorder();
    await answers.render(i, { content: "a" }, edit);
    await answers.render(i, { content: "b" }, edit);
    expect(i.calls).toEqual(["update", "editReply"]);
    expect(edits).toHaveLength(0);
});

test("watchdog ack still in flight, then render: render waits for the deferUpdate and edits the reply", async () => {
    const answers = createInteractionAnswers();
    const i = fakeInteraction({ manual: true });
    const { edit } = editRecorder();
    const ack = answers.acknowledge(i);
    const render = answers.render(i, { content: "late" }, edit);
    await settle();
    expect(i.calls).toEqual(["deferUpdate"]); // render hasn't touched the interaction yet
    i.release();
    await ack;
    await settle();
    expect(i.calls).toEqual(["deferUpdate", "editReply"]);
    i.release();
    await render;
});

test("acknowledge is a no-op on an interaction already answered (never answered twice)", async () => {
    const answers = createInteractionAnswers();
    const i = fakeInteraction();
    const { edit } = editRecorder();
    await answers.render(i, { content: "a" }, edit);
    await answers.acknowledge(i);
    await answers.acknowledge(i);
    expect(i.calls).toEqual(["update"]);
});

test("notify then render: notify replies ephemerally, the render edits the message itself (not the ephemeral reply)", async () => {
    const answers = createInteractionAnswers();
    const i = fakeInteraction();
    const { edits, edit } = editRecorder();
    await answers.notify(i, "nope");
    await answers.render(i, { content: "a" }, edit);
    expect(i.calls).toEqual(["reply"]);
    expect(i.bodies[0]).toMatchObject({ content: "nope", flags: MessageFlags.Ephemeral });
    expect(edits).toEqual([{ content: "a" }]);
});

test("notify on an already answered click follows up ephemerally", async () => {
    const answers = createInteractionAnswers();
    const i = fakeInteraction();
    await answers.acknowledge(i);
    await answers.notify(i, "late");
    expect(i.calls).toEqual(["deferUpdate", "followUp"]);
    expect(i.bodies[1]).toMatchObject({ content: "late", flags: MessageFlags.Ephemeral });
});

test("showModal answers an unanswered click once; a click already answered can't show one", async () => {
    const answers = createInteractionAnswers();
    const fresh = fakeInteraction();
    expect(await answers.showModal(fresh, {})).toBe(true);
    await answers.acknowledge(fresh);
    expect(fresh.calls).toEqual(["showModal"]);

    const acked = fakeInteraction();
    await answers.acknowledge(acked);
    expect(await answers.showModal(acked, {})).toBe(false);
    expect(acked.calls).toEqual(["deferUpdate"]);
});

test("a modal submit from the message is updated; one not from a message falls back to editing the message", async () => {
    const answers = createInteractionAnswers();
    const { edits, edit } = editRecorder();
    const fromMessage = fakeInteraction({ fromMessage: true });
    await answers.render(fromMessage, { content: "a" }, edit);
    expect(fromMessage.calls).toEqual(["update"]);

    const detached = fakeInteraction({ fromMessage: false });
    await answers.render(detached, { content: "b" }, edit);
    await answers.acknowledge(detached);
    expect(detached.calls).toEqual([]);
    expect(edits).toEqual([{ content: "b" }]);
});

test("a failed update leaves the click unanswered, so the next answer still goes through", async () => {
    const answers = createInteractionAnswers();
    const i = fakeInteraction();
    i.update = async () => {
        i.calls.push("update!");
        throw new Error("400");
    };
    const { edit } = editRecorder();
    await expect(answers.render(i, { content: "bad" }, edit)).rejects.toThrow("400");
    await answers.acknowledge(i);
    expect(i.calls).toEqual(["update!", "deferUpdate"]);
});

test("lastEditor is the latest interaction whose token can edit the message (updated or deferred)", async () => {
    const answers = createInteractionAnswers();
    const { edit } = editRecorder();
    expect(answers.lastEditor()).toBeNull();
    const a = fakeInteraction();
    await answers.render(a, { content: "a" }, edit);
    expect(answers.lastEditor()).toBe(a);
    const b = fakeInteraction();
    await answers.notify(b, "x"); // an ephemeral reply's token edits the reply, not the message
    expect(answers.lastEditor()).toBe(a);
    await answers.acknowledge(b);
    const c = fakeInteraction();
    await answers.acknowledge(c);
    expect(answers.lastEditor()).toBe(c);
});
