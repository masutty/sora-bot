import { expect, test } from "bun:test";
import { Collection } from "discord.js";
import { validateCapture } from "./capture";

function msg(over: Record<string, unknown> = {}) {
    return {
        content: "hello",
        attachments: new Collection(),
        stickers: new Collection(),
        poll: null,
        messageSnapshots: new Collection(),
        ...over,
    } as never;
}

test("plain text is kept raw", () => {
    const content = "**bold** <@&123> @everyone";
    expect(validateCapture(msg({ content }))).toEqual({ ok: true, content });
});

test("attachments are refused", () => {
    const attachments = new Collection([["1", {}]]);
    expect(validateCapture(msg({ attachments }))).toEqual({
        ok: false,
        reason: "Stickies are text only. Send it again without attachments.",
    });
});

test("stickers, polls and forwards are refused", () => {
    const reason = "Stickies are text only.";
    expect(validateCapture(msg({ stickers: new Collection([["1", {}]]) }))).toEqual({ ok: false, reason });
    expect(validateCapture(msg({ poll: {} }))).toEqual({ ok: false, reason });
    expect(validateCapture(msg({ messageSnapshots: new Collection([["1", {}]]) }))).toEqual({ ok: false, reason });
});

test("empty and whitespace are refused", () => {
    expect(validateCapture(msg({ content: "" }))).toEqual({ ok: false, reason: "Send some text." });
    expect(validateCapture(msg({ content: "  \n " }))).toEqual({ ok: false, reason: "Send some text." });
});

test("over 2000 characters is refused, exactly 2000 is fine", () => {
    expect(validateCapture(msg({ content: "a".repeat(2001) }))).toEqual({ ok: false, reason: "Keep it under 2000 characters." });
    expect(validateCapture(msg({ content: "a".repeat(2000) })).ok).toBe(true);
});
