import { expect, test } from "bun:test";

import { type ActivitySessionRow, type RareFind, VoteStatus } from "../types";
import { buildRareFindsPage, rareFindsView } from "./rare-finds.view";

function find(at: string, status?: VoteStatus): RareFind {
    return {
        eventId: 1,
        biome: "GLITCHED",
        at: new Date(at),
        macroMessageId: null,
        macroChannelId: null,
        vote: status
            ? { id: "v", status, decidedBy: null, channelId: "c", messageId: "m", jumpLink: "https://x/y", real: 0, fake: 3 }
            : null,
    };
}

const session = (id: number, from: string, to: string): ActivitySessionRow => ({
    id,
    user_id: 1,
    started_at: new Date(from),
    ended_at: new Date(to),
    duration_seconds: 3600,
});

const contentOf = (c: ReturnType<typeof buildRareFindsPage>) =>
    (c.toJSON().components as Array<{ content?: string }>).map((x) => x.content ?? "").join("\n");

test("groups finds by session newest first", () => {
    const sessions = [
        session(8, "2026-01-02T10:00:00Z", "2026-01-02T11:00:00Z"),
        session(7, "2026-01-01T10:00:00Z", "2026-01-01T11:00:00Z"),
    ];
    const finds = [find("2026-01-02T10:30:00Z"), find("2026-01-02T10:10:00Z"), find("2026-01-01T10:30:00Z"), find("2025-12-30T10:30:00Z")];
    const text = contentOf(buildRareFindsPage("masutty", "g1", finds, sessions, 0));
    expect(text).toContain("## `masutty`'s Rare Finds");
    const i8 = text.indexOf("**Session** `#8` · <t:1767348000:D>");
    const i7 = text.indexOf("**Session** `#7` · <t:1767261600:D>");
    expect(i8).toBeGreaterThan(-1);
    expect(i7).toBeGreaterThan(i8);
    expect(text.match(/\*\*Session\*\* `#8`/g)).toHaveLength(1);
    expect(text).toContain("\n- ");
    expect(text).toContain("\n<t:1767090600:D>\n- ");
});

test("10 finds per page", () => {
    const finds = Array.from({ length: 12 }, (_, i) => find(`2026-01-01T10:${String(59 - i).padStart(2, "0")}:00Z`));
    const count = (page: number) => (contentOf(buildRareFindsPage("m", "g1", finds, [], page)).match(/\*\*Glitched\*\*/gi) ?? []).length;
    expect(count(0)).toBe(10);
    expect(count(1)).toBe(2);
});

test("empty state", () => {
    expect(contentOf(buildRareFindsPage("masutty", "g1", [], [], 0))).toBe("## `masutty`'s Rare Finds\nNo rare finds yet.");
});

test("lists fake and denied finds", () => {
    const finds = [
        find("2026-01-01T10:30:00Z", VoteStatus.COMMUNITY_FAKE),
        { ...find("2026-01-01T10:20:00Z", VoteStatus.ADMIN_DENIED), eventId: null },
    ];
    const text = contentOf(buildRareFindsPage("m", "g1", finds, [], 0));
    expect(text).toContain("❌ Fake");
    expect(text).toContain("❌ Denied");
});

test("view starts on the first page with the member's name", () => {
    const view = rareFindsView("masutty");
    expect(view.initial({ username: "ignored", guildId: "g1", finds: [], sessions: [] })).toMatchObject({ username: "masutty", page: 0 });
});
