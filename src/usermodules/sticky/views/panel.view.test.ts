import { expect, test } from "bun:test";
import { createFakeViewTransport, type ViewPayload } from "@/define";
import type { ChannelAccess } from "../services/channel-access";
import type { StickyService } from "../services/sticky.service";
import { StickyError, type StickyRow } from "../types";
import { stickyPanelView } from "./panel.view";

const OWNER = "owner";

function nodes(payload: ViewPayload): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    const walk = (node: unknown) => {
        if (node === null || typeof node !== "object") return;
        const json = typeof (node as { toJSON?: unknown }).toJSON === "function" ? (node as { toJSON(): unknown }).toJSON() : node;
        if (Array.isArray(json)) return void json.forEach(walk);
        const obj = json as Record<string, unknown>;
        if (typeof obj.type === "number") out.push(obj);
        walk(obj.components);
        walk(obj.accessory);
    };
    walk(payload.components);
    return out;
}

const text = (p: ViewPayload) =>
    nodes(p)
        .map((n) => (typeof n.content === "string" ? n.content : ""))
        .join("\n");
const byKey = (p: ViewPayload, key: string) => nodes(p).find((n) => typeof n.custom_id === "string" && n.custom_id.endsWith(`:${key}`));

const row = (channel: string, over: Partial<StickyRow> = {}): StickyRow => ({
    guild_id: "g1",
    channel_id: channel,
    content: "Read the rules",
    mode: "all",
    delay_seconds: 3600,
    message_id: null,
    last_posted_at: null,
    created_by: OWNER,
    created_at: new Date(0),
    ...over,
});

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

interface Options {
    limit?: number;
    access?: (id: string) => ChannelAccess;
    createError?: Error;
    channels?: { id: string; name: string; position: number }[];
    postResult?: { posted: false; reason: string };
}

function setup(seed: StickyRow[], opts: Options = {}) {
    let rows = seed;
    const log: string[] = [];
    const update = (id: string, patch: Partial<StickyRow>) => {
        rows = rows.map((r) => (r.channel_id === id ? { ...r, ...patch } : r));
        return rows.find((r) => r.channel_id === id) as StickyRow;
    };
    const service: StickyService = {
        overview: async () => ({ stickies: rows, used: rows.length, limit: opts.limit ?? 5 }),
        create: async (i) => {
            if (opts.createError) throw opts.createError;
            log.push(`create ${i.channelId} ${i.content}`);
            const r = row(i.channelId, { content: i.content });
            rows = [...rows, r];
            return { ...(opts.postResult ?? { posted: true as const }), sticky: r };
        },
        editContent: async (id, content) => {
            log.push(`edit ${id} ${content}`);
            return { ...(opts.postResult ?? { posted: true as const }), sticky: update(id, { content }) };
        },
        setMode: async (id, mode) => {
            log.push(`mode ${id} ${mode}`);
            return update(id, { mode });
        },
        setDelay: async (id, sec) => {
            log.push(`delay ${id} ${sec}`);
            return update(id, { delay_seconds: sec });
        },
        remove: async (id) => {
            log.push(`remove ${id}`);
            rows = rows.filter((r) => r.channel_id !== id);
        },
        get: (id) => rows.find((r) => r.channel_id === id),
    };
    const fake = createFakeViewTransport();
    void fake.run(
        stickyPanelView({
            guildId: "g1",
            userId: OWNER,
            service,
            access: opts.access ?? (() => "ok"),
            channels: opts.channels && (() => opts.channels ?? []),
        }),
        undefined,
        OWNER,
    );
    return { fake, log };
}

test("the list shows used/limit and one line per sticky", async () => {
    const { fake } = setup([row("c1"), row("c2", { mode: "nobots", delay_seconds: 300 }), row("c3")]);
    await fake.flush();
    const t = text(fake.lastPayload());
    expect(t).toContain("**Stickies · 3/5**");
    expect(t).toContain("<#c1> · All messages · 1 hour");
    expect(t).toContain("<#c2> · No bots · 5 min");
    expect(byKey(fake.lastPayload(), "create")?.disabled).toBe(false);
});

test("an empty list says so", async () => {
    const { fake } = setup([]);
    await fake.flush();
    expect(text(fake.lastPayload())).toContain("No stickies yet.");
});

test("Create is disabled at the limit", async () => {
    const { fake } = setup([row("c1"), row("c2")], { limit: 2 });
    await fake.flush();
    expect(byKey(fake.lastPayload(), "create")?.disabled).toBe(true);
});

test("picking a sticky opens its detail", async () => {
    const { fake } = setup([row("c1")]);
    await fake.flush();
    await fake.emit(fake.click("pick", OWNER, ["c1"]));
    expect(text(fake.lastPayload())).toContain("**Sticky · <#c1>**");
    expect(text(fake.lastPayload())).toContain("Read the rules");
});

test("the mode and delay selects save at once", async () => {
    const { fake, log } = setup([row("c1")]);
    await fake.flush();
    await fake.emit(fake.click("pick", OWNER, ["c1"]));
    await fake.emit(fake.click("mode", OWNER, ["nobots"]));
    await fake.emit(fake.click("delay", OWNER, ["300"]));
    expect(log).toEqual(["mode c1 nobots", "delay c1 300"]);
    const options = byKey(fake.lastPayload(), "mode")?.options as { value: string; default?: boolean }[];
    expect(options.find((o) => o.value === "nobots")?.default).toBe(true);
});

test("a channel that already has a sticky is refused", async () => {
    const { fake } = setup([row("c1")]);
    await fake.flush();
    await fake.emit(fake.click("create", OWNER));
    await fake.emit(fake.click("channel", OWNER, ["c1"]));
    expect(fake.notifies[0]?.content).toContain("already has a sticky");
    expect(byKey(fake.lastPayload(), "channel")).toBeDefined();
});

test("a channel the bot cannot use is refused with the access message", async () => {
    const { fake } = setup([], { access: () => "bot_missing_perms" });
    await fake.flush();
    await fake.emit(fake.click("create", OWNER));
    await fake.emit(fake.click("channel", OWNER, ["c9"]));
    expect(fake.notifies[0]?.content).toContain("Manage Messages");
    expect(byKey(fake.lastPayload(), "channel")).toBeDefined();
});

test("capture creates the sticky in the chosen channel and shows its detail", async () => {
    const { fake, log } = setup([]);
    await fake.flush();
    await fake.emit(fake.click("create", OWNER));
    await fake.emit(fake.click("channel", OWNER, ["c9"]));
    expect(text(fake.lastPayload())).toContain("Send the sticky for <#c9>.");
    expect(fake.textListening).toBe(true);
    await fake.emit(message(OWNER, "Welcome"));
    expect(log).toEqual(["create c9 Welcome"]);
    expect(text(fake.lastPayload())).toContain("**Sticky · <#c9>**");
});

test("the channel step lists only eligible channels, sorted by position, as a string select", async () => {
    const { fake } = setup([row("c2")], {
        channels: [
            { id: "c3", name: "later", position: 5 },
            { id: "c2", name: "has-sticky", position: 0 },
            { id: "c1", name: "first", position: 1 },
            { id: "c4", name: "no-perms", position: 2 },
        ],
        access: (id) => (id === "c4" ? "bot_missing_perms" : "ok"),
    });
    await fake.flush();
    await fake.emit(fake.click("create", OWNER));
    const options = byKey(fake.lastPayload(), "channel")?.options as { label: string; value: string }[];
    expect(options.map((o) => [o.label, o.value])).toEqual([
        ["#first", "c1"],
        ["#later", "c3"],
    ]);
    await fake.emit(fake.click("channel", OWNER, ["c1"]));
    expect(text(fake.lastPayload())).toContain("Send the sticky for <#c1>.");
});

test("with no eligible channel the step says so and offers Back", async () => {
    const { fake } = setup([], { channels: [] });
    await fake.flush();
    await fake.emit(fake.click("create", OWNER));
    expect(text(fake.lastPayload())).toContain("No channels available.");
    expect(byKey(fake.lastPayload(), "channel")).toBeUndefined();
    expect(byKey(fake.lastPayload(), "back")).toBeDefined();
});

test("with more than 25 eligible channels the full channel select stays", async () => {
    const channels = Array.from({ length: 26 }, (_, i) => ({ id: `c${i}`, name: `n${i}`, position: i }));
    const { fake } = setup([], { channels });
    await fake.flush();
    await fake.emit(fake.click("create", OWNER));
    expect(byKey(fake.lastPayload(), "channel")?.options).toBeUndefined();
    expect(byKey(fake.lastPayload(), "channel")).toBeDefined();
});

test("a failed post is told after the sticky is saved", async () => {
    const { fake } = setup([], { postResult: { posted: false, reason: "I need Send Messages and Manage Messages there." } });
    await fake.flush();
    await fake.emit(fake.click("create", OWNER));
    await fake.emit(fake.click("channel", OWNER, ["c9"]));
    await fake.emit(message(OWNER, "Welcome"));
    expect(fake.notifies[0]?.content).toContain("but I couldn't post it");
    expect(text(fake.lastPayload())).toContain("**Sticky · <#c9>**");
});

test("capture with an attachment is refused and stays on capture", async () => {
    const { fake, log } = setup([]);
    await fake.flush();
    await fake.emit(fake.click("create", OWNER));
    await fake.emit(fake.click("channel", OWNER, ["c9"]));
    await fake.emit(message(OWNER, "x", { attachments: new Map([["a", {}]]) }));
    expect(log).toEqual([]);
    expect(fake.notifies[0]?.content).toContain("text only");
    expect(text(fake.lastPayload())).toContain("Send the sticky for <#c9>.");
});

test("a StickyError from create is told and capture stays", async () => {
    const { fake } = setup([], { createError: new StickyError("This server is at its sticky limit (5/5).") });
    await fake.flush();
    await fake.emit(fake.click("create", OWNER));
    await fake.emit(fake.click("channel", OWNER, ["c9"]));
    await fake.emit(message(OWNER, "ok"));
    expect(fake.notifies[0]?.content).toContain("5/5");
    expect(text(fake.lastPayload())).toContain("Send the sticky for <#c9>.");
});

test("Edit replaces the text of the open sticky", async () => {
    const { fake, log } = setup([row("c1")]);
    await fake.flush();
    await fake.emit(fake.click("pick", OWNER, ["c1"]));
    await fake.emit(fake.click("editContent", OWNER));
    await fake.emit(message(OWNER, "New text"));
    expect(log).toEqual(["edit c1 New text"]);
    expect(text(fake.lastPayload())).toContain("New text");
});

test("Cancel on capture goes back to the sticky", async () => {
    const { fake } = setup([row("c1")]);
    await fake.flush();
    await fake.emit(fake.click("pick", OWNER, ["c1"]));
    await fake.emit(fake.click("editContent", OWNER));
    await fake.emit(fake.click("cancel", OWNER));
    expect(text(fake.lastPayload())).toContain("**Sticky · <#c1>**");
});

test("Delete asks first, then removes and returns to the list", async () => {
    const { fake, log } = setup([row("c1")]);
    await fake.flush();
    await fake.emit(fake.click("pick", OWNER, ["c1"]));
    await fake.emit(fake.click("delete", OWNER));
    expect(text(fake.lastPayload())).toContain("Delete this sticky?");
    expect(log).toEqual([]);
    await fake.emit(fake.click("yes", OWNER));
    expect(log).toEqual(["remove c1"]);
    expect(text(fake.lastPayload())).toContain("No stickies yet.");
});
