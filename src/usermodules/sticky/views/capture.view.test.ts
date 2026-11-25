import { expect, test } from "bun:test";
import { createFakeViewTransport, type ViewPayload } from "@/define";
import { StickyError } from "../types";
import { captureView } from "./capture.view";

const OWNER = "owner";

function texts(payload: ViewPayload): string {
    const out: string[] = [];
    const walk = (node: unknown) => {
        if (node === null || typeof node !== "object") return;
        const json = typeof (node as { toJSON?: unknown }).toJSON === "function" ? (node as { toJSON(): unknown }).toJSON() : node;
        if (Array.isArray(json)) return void json.forEach(walk);
        const obj = json as Record<string, unknown>;
        if (typeof obj.content === "string") out.push(obj.content);
        walk(obj.components);
    };
    walk(payload.components);
    return out.join("\n");
}

/** A typed message with the fields validateCapture reads. */
function message(userId: string, content: string, extra: Record<string, unknown> = {}) {
    return {
        kind: "text" as const,
        userId,
        content,
        raw: {
            author: { id: userId },
            content,
            attachments: new Map(),
            stickers: new Map(),
            poll: null,
            messageSnapshots: new Map(),
            ...extra,
        },
    } as never;
}

function setup(save = async (_content: string) => "Sticky saved.") {
    const saved: string[] = [];
    const fake = createFakeViewTransport();
    const result = fake.run(
        captureView({
            title: "Send the sticky for <#1>.",
            save: async (content) => {
                saved.push(content);
                return save(content);
            },
        }),
        undefined,
        OWNER,
    );
    return { fake, saved, result };
}

test("text from the invoker is saved and ends the view", async () => {
    const { fake, saved, result } = setup();
    await fake.flush();
    expect(texts(fake.lastPayload())).toContain("Send the sticky for <#1>.");
    await fake.emit(message(OWNER, "Read the rules"));
    expect(saved).toEqual(["Read the rules"]);
    expect(await result).toBe(true);
    expect(texts(fake.lastPayload())).toContain("Sticky saved.");
    expect(fake.deletedTexts).toHaveLength(1);
});

test("text from another user is ignored", async () => {
    const { fake, saved } = setup();
    await fake.flush();
    await fake.emit(message("other", "hello"));
    expect(saved).toEqual([]);
    expect(texts(fake.lastPayload())).toContain("Send the sticky for <#1>.");
});

test("an attachment is refused and the view keeps waiting", async () => {
    const { fake, saved } = setup();
    await fake.flush();
    await fake.emit(message(OWNER, "see this", { attachments: new Map([["a", {}]]) }));
    expect(saved).toEqual([]);
    expect(fake.notifies[0]?.content).toContain("text only");
    expect(texts(fake.lastPayload())).toContain("Send the sticky for <#1>.");
});

test("a StickyError from save is told to the user and the view keeps waiting", async () => {
    const { fake, result } = setup(async () => {
        throw new StickyError("This server is at its sticky limit (5/5).");
    });
    await fake.flush();
    await fake.emit(message(OWNER, "hello"));
    expect(fake.notifies[0]?.content).toContain("5/5");
    await fake.emit(fake.click("cancel", OWNER));
    expect(await result).toBe(false);
});

test("30 seconds without a message cancels", async () => {
    const { fake, result } = setup();
    await fake.flush();
    await fake.clock.advance(30_000);
    expect(await result).toBeUndefined();
    expect(JSON.stringify(fake.lastPayload())).toContain("No message in 30 seconds. Cancelled.");
});

test("Cancel ends with false", async () => {
    const { fake, saved, result } = setup();
    await fake.flush();
    await fake.emit(fake.click("cancel", OWNER));
    expect(await result).toBe(false);
    expect(saved).toEqual([]);
    expect(texts(fake.lastPayload())).toContain("Cancelled.");
});
