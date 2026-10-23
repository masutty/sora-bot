import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { createFakeViewTransport, defineView, type ViewPayload } from "@/define";
import * as realRepo from "../repository/activity.repository";
import * as realFinds from "../services/rare-finds.service";
import type { ActivitySessionRow, RareFind } from "../types";

const SESSION_ROW = {
    id: 7,
    user_id: 1,
    discord_user_id: "u1",
    started_at: new Date("2026-01-01T10:00:00Z"),
    ended_at: new Date("2026-01-01T11:00:00Z"),
    duration_seconds: 3600,
};

mock.module("../repository/activity.repository", () => ({
    getSessionInGuild: async (guildId: string) => (guildId === "g1" ? SESSION_ROW : null),
    getBiomeCountsInRange: async () => [{ biome: "GLITCHED", count: 1 }],
}));
mock.module("../services/rare-finds.service", () => ({
    loadRareFinds: async () => [],
    findsInSession: (all: RareFind[]) => all,
    formatFindLine: (_g: string, f: RareFind) => `<t:1:t> · **${f.biome}**\n-# [Macro message](https://x/${f.biome})`,
}));

type View = typeof import("./session.view");
let buildSessionContainer: View["buildSessionContainer"];
let sessionView: View["sessionView"];
let openSessionView: View["openSessionView"];
let openSessionFromTab: View["openSessionFromTab"];
afterAll(() => {
    mock.module("../repository/activity.repository", () => realRepo);
    mock.module("../services/rare-finds.service", () => realFinds);
});
beforeAll(async () => {
    ({ buildSessionContainer, sessionView, openSessionView, openSessionFromTab } = await import("./session.view"));
});

const session: ActivitySessionRow = {
    id: 7,
    user_id: 1,
    started_at: SESSION_ROW.started_at,
    ended_at: SESSION_ROW.ended_at,
    duration_seconds: 3600,
};

const find = (biome: string) => ({ biome, at: new Date("2026-01-01T10:30:00Z"), vote: null }) as unknown as RareFind;

function text(payload: Pick<ViewPayload, "components">): string {
    const out: string[] = [];
    const walk = (node: unknown) => {
        if (node === null || typeof node !== "object") return;
        const json = typeof (node as { toJSON?: unknown }).toJSON === "function" ? (node as { toJSON(): unknown }).toJSON() : node;
        if (Array.isArray(json)) {
            for (const child of json) walk(child);
            return;
        }
        const obj = json as { content?: string; components?: unknown };
        if (obj.content) out.push(obj.content);
        walk(obj.components);
    };
    walk(payload.components);
    return out.join("\n");
}

const input = (f: RareFind[]) => ({
    guildId: "g1",
    session,
    discordUserId: "u1",
    finds: f,
    biomes: [{ biome: "GLITCHED", count: 1 }],
});

test("renders rare finds in a blockquote", () => {
    const out = text({ components: [buildSessionContainer(input([find("A"), find("B")]))] });
    expect(out).toContain("## Session `#7` · `1h");
    expect(out).toContain("<@u1>");
    expect(out).toContain(
        "**Rare finds**\n> <t:1:t> · **A**\n> -# [Macro message](https://x/A)\n> <t:1:t> · **B**\n> -# [Macro message](https://x/B)",
    );
    expect(out).toContain("**Biomes found**");
});

test("omits the rare section when there are none", () => {
    const out = text({ components: [buildSessionContainer(input([]))] });
    expect(out).not.toContain("Rare finds");
    expect(out).toContain("**Biomes found**");
});

test("back button only when opened from a tab", async () => {
    for (const back of [true, false]) {
        const fake = createFakeViewTransport();
        void fake.run(sessionView({ back }), input([]), "owner");
        await fake.flush();
        expect(JSON.stringify(fake.lastPayload().components).includes(":back")).toBe(back);
    }
});

test("unknown or other-guild id shows the error", async () => {
    const replies: Array<Pick<ViewPayload, "components"> & { allowedMentions?: unknown }> = [];
    const opened: unknown[] = [];
    const ctx = {
        reply: async (r: (typeof replies)[number]) => void replies.push(r),
        open: async (...a: unknown[]) => void opened.push(a),
    };
    await openSessionView(ctx as never, "other-guild", 7);
    expect(opened).toHaveLength(0);
    expect(text(replies[0] as Pick<ViewPayload, "components">)).toContain("No session `#7` on this server.");

    expect(replies[0]?.allowedMentions).toEqual({ parse: [] });

    await openSessionView(ctx as never, "g1", 7);
    expect(opened).toHaveLength(1);
});

test("openSessionFromTab: ignores ids off the page, notifies on a missing session, opens the child and leaves the tab as it was", async () => {
    const loaded: number[] = [];
    const deps = {
        loadSessionInput: async (_g: string, id: number) => {
            loaded.push(id);
            return id === 7 ? input([]) : null;
        },
    };
    const notes: string[] = [];
    const notify = async (m: string) => void notes.push(m);
    const host = defineView<{ tab: string; page: number }, void, void>({
        name: "test.host",
        initial: () => ({ tab: "sessions", page: 2 }),
        render: (s, kit) => ({ components: [kit.row(kit.button("inspect", (b) => b.setLabel(`${s.tab}:${s.page}`)))] }),
        on: { inspect: (c) => openSessionFromTab({ open: c.open, notify }, "g1", 7, [7, 8], deps) },
    });
    const fake = createFakeViewTransport();
    void fake.run(host, undefined, "owner");
    await fake.flush();

    // Not on the page: nothing is loaded.
    await openSessionFromTab({ open: async () => undefined, notify }, "g1", 99, [7, 8], deps);
    expect(loaded).toEqual([]);

    // Missing session: notifies.
    await openSessionFromTab({ open: async () => undefined, notify }, "g1", 8, [7, 8], deps);
    expect(notes).toEqual(["No session `#8` on this server."]);

    // Found: opens the session view with a Back button; Back returns to the same tab and page.
    await fake.emit(fake.click("inspect", "owner"));
    expect(JSON.stringify(fake.lastPayload().components)).toContain(":back");
    await fake.emit(fake.click("back", "owner"));
    expect(JSON.stringify(fake.lastPayload().components)).toContain("sessions:2");
});
