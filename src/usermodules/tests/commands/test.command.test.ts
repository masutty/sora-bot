import { expect, test } from "bun:test";
import type { BotClient } from "@/core/bot-client";
import { createFakeViewTransport, type ViewPayload } from "@/define";
import { config } from "../../../config";
import { type PickerOption, pickerView } from "./test.command";

const OWNER = "owner";

type Json = { content?: string; components?: Json[] };

/** Every text on the message (content + text displays), joined by newlines - same shape as the
 * framework's own helpers.test.ts, kept local since it's test-only glue. */
function text(payload: ViewPayload): string {
    const out: string[] = [];
    const walk = (node: unknown) => {
        if (node === null || typeof node !== "object") return;
        const json = typeof (node as { toJSON?: unknown }).toJSON === "function" ? (node as { toJSON(): unknown }).toJSON() : node;
        if (Array.isArray(json)) {
            for (const child of json) walk(child);
            return;
        }
        const obj = json as Json;
        if (obj.content) out.push(obj.content);
        walk(obj.components);
    };
    if (payload.content) out.push(payload.content);
    walk(payload.components);
    return out.join("\n");
}

const OPTIONS: PickerOption[] = [{ key: "embed/session-end", description: "desc" }];

test("tests.picker: another user's pick is rejected ephemerally and doesn't consume the picker", async () => {
    const fake = createFakeViewTransport();
    void fake.run(pickerView({} as BotClient), OPTIONS, OWNER);
    await fake.flush();

    await fake.emit(fake.click("pick", "intruder", ["embed/session-end"]));

    expect(fake.notifies.at(-1)?.content).toBe("This isn't yours!");
    // The select menu is still there - a killed picker (the old collector's `max: 1` behavior)
    // would show an error/result screen instead.
    expect(() => fake.id("pick")).not.toThrow();
});

test("tests.picker: the owner picking a registered single-page case replaces the picker in place", async () => {
    const fake = createFakeViewTransport();
    void fake.run(pickerView({} as BotClient), OPTIONS, OWNER);
    await fake.flush();

    await fake.emit(fake.click("pick", OWNER, ["embed/session-end"]));

    expect(() => fake.id("pick")).toThrow();
});

test("tests.picker: an unregistered key shows an error and the picker doesn't come back", async () => {
    const fake = createFakeViewTransport();
    void fake.run(pickerView({} as BotClient), [{ key: "gone" }], OWNER);
    await fake.flush();

    await fake.emit(fake.click("pick", OWNER, ["gone"]));

    expect(text(fake.lastPayload())).toContain("isn't registered anymore");
    expect(() => fake.id("pick")).toThrow();
});

test('tests.picker: an untouched picker expires with "Picker timed out - nothing selected."', async () => {
    const fake = createFakeViewTransport();
    const result = fake.run(pickerView({} as BotClient), OPTIONS, OWNER);
    await fake.flush();

    await fake.clock.advance(config.ui.viewTimeoutMs);

    expect(await result).toBeUndefined();
    expect(text(fake.lastPayload())).toContain("Picker timed out - nothing selected.");
    expect(() => fake.id("pick")).toThrow();
});

test("tests.picker: after picking a single-page case, expiry just leaves that content (no picker warning)", async () => {
    const fake = createFakeViewTransport();
    void fake.run(pickerView({} as BotClient), OPTIONS, OWNER);
    await fake.flush();
    await fake.emit(fake.click("pick", OWNER, ["embed/session-end"]));

    await fake.clock.advance(config.ui.viewTimeoutMs);

    expect(text(fake.lastPayload())).not.toContain("Picker timed out");
});
