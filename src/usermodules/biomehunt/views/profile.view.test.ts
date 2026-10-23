import { expect, test } from "bun:test";
import type { GuildMember } from "discord.js";
import { createFakeViewTransport, type ViewPayload } from "@/define";
import { type ActivitySessionRow, type RareFind, type UserRow, VoteStatus } from "../types";
import { profileView } from "./profile.view";
import { type ProfileData, sessionOptionLabel } from "./stats-builders";

const OWNER = "owner";

function fakeMember(): GuildMember {
    return {
        id: "u1",
        user: { username: "tester" },
        displayAvatarURL: () => "https://example.com/avatar.png",
    } as unknown as GuildMember;
}

function fakeUser(overrides: Partial<UserRow> = {}): UserRow {
    return {
        id: 1,
        guild_id: "g1",
        discord_user_id: "u1",
        current_status: "idle",
        last_activity_at: null,
        activity_grace_until: null,
        activity_grace_biome: null,
        paused_at: null,
        created_at: new Date("2024-01-01T00:00:00Z"),
        seeds: 0,
        xp: 0,
        flower: null,
        ...overrides,
    };
}

/** 24 completed sessions (idle, so none is "ongoing") - 3 pages at SESSIONS_PER_PAGE=10. */
function fakeSessions(count: number): ActivitySessionRow[] {
    return Array.from({ length: count }, (_, i) => ({
        id: count - i,
        user_id: 1,
        started_at: new Date(Date.now() - (count - i) * 3_600_000),
        ended_at: new Date(Date.now() - (count - i) * 3_600_000 + 60_000),
        duration_seconds: 60,
    }));
}

function fakeData(overrides: Partial<ProfileData> = {}): ProfileData {
    return {
        user: fakeUser(),
        activeSeconds: 0,
        activeSecondsToday: 0,
        quotaDayStart: new Date(),
        quotaDayEnd: new Date(),
        biomes: [],
        channelId: null,
        flower: null,
        quotaSummaryLines: [],
        badges: [],
        sessions: fakeSessions(24),
        rareFinds: [],
        flowersEnabled: false,
        economyEnabled: false,
        ...overrides,
    };
}

function find(at: Date, biome = "GLITCHED", status?: VoteStatus): RareFind {
    return {
        eventId: 1,
        biome,
        at,
        macroMessageId: null,
        macroChannelId: null,
        vote: status ? { id: "v", status, decidedBy: null, channelId: "c", messageId: "m", jumpLink: "x", real: 0, fake: 0 } : null,
    };
}

type Json = { custom_id?: string; options?: Array<{ label: string; value: string }>; label?: string; components?: Json[] };

function flatten(payload: ViewPayload): Json[] {
    const out: Json[] = [];
    const walk = (node: unknown) => {
        if (node === null || typeof node !== "object") return;
        const json = typeof (node as { toJSON?: unknown }).toJSON === "function" ? (node as { toJSON(): unknown }).toJSON() : node;
        if (Array.isArray(json)) {
            for (const child of json) walk(child);
            return;
        }
        out.push(json as Json);
        walk((json as Json).components);
    };
    walk(payload.components);
    return out;
}

const comp = (payload: ViewPayload, key: string) => flatten(payload).find((c) => c.custom_id?.endsWith(`:${key}`));

function text(payload: ViewPayload): string {
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

test("biomehunt.profile: opens on the Profile tab", async () => {
    const fake = createFakeViewTransport();
    void fake.run(profileView(fakeMember()), fakeData(), OWNER);
    await fake.flush();

    expect(text(fake.lastPayload())).toContain("`tester`'s Profile");
});

test("profile sessions tab uses paginationRow", async () => {
    const fake = createFakeViewTransport();
    void fake.run(profileView(fakeMember()), fakeData(), OWNER);
    await fake.flush();

    await fake.emit(fake.click("tab:sessions", OWNER));
    expect(text(fake.lastPayload())).toContain("Page 1 of 3");
    expect(comp(fake.lastPayload(), "jump")?.label).toBe("1 / 3");
    expect(comp(fake.lastPayload(), "sessionsNext")).toBeUndefined();

    await fake.emit(fake.click("next", OWNER));
    expect(text(fake.lastPayload())).toContain("Page 2 of 3");

    // Leaving and coming back to the Sessions tab resets its page.
    await fake.emit(fake.click("tab:profile", OWNER));
    await fake.emit(fake.click("tab:sessions", OWNER));
    expect(text(fake.lastPayload())).toContain("Page 1 of 3");
});

test("session lines end with rare badge emojis", async () => {
    const sessions = fakeSessions(3);
    const rareFinds = [
        find(new Date(sessions[0].started_at.getTime() + 1000)),
        find(new Date(sessions[0].started_at.getTime() + 2000)),
        find(new Date(sessions[1].started_at.getTime() + 1000), "GLITCHED", VoteStatus.COMMUNITY_FAKE),
    ];
    const fake = createFakeViewTransport();
    void fake.run(profileView(fakeMember()), fakeData({ sessions, rareFinds }), OWNER);
    await fake.flush();
    await fake.emit(fake.click("tab:sessions", OWNER));

    const lines = text(fake.lastPayload()).split("\n");
    expect(lines.find((l) => l.includes("`#3`"))).toMatch(/:R> · 🔥🔥$/);
    expect(lines.find((l) => l.includes("`#2`"))).toMatch(/:R>$/);
});

test("inspect select lists the page's sessions", async () => {
    const fake = createFakeViewTransport();
    void fake.run(profileView(fakeMember()), fakeData(), OWNER);
    await fake.flush();
    await fake.emit(fake.click("tab:sessions", OWNER));

    const select = comp(fake.lastPayload(), "inspectSession");
    expect(select?.options?.map((o) => o.value)).toEqual(Array.from({ length: 10 }, (_, i) => String(24 - i)));
    expect(select?.options?.[0].label).toBe("#24 · 1m");

    await fake.emit(fake.click("next", OWNER));
    expect(comp(fake.lastPayload(), "inspectSession")?.options?.[0].value).toBe("14");
});

test("truncates long option labels", () => {
    const [session] = fakeSessions(1);
    const finds = Array.from({ length: 60 }, (_, i) => find(new Date(session.started_at.getTime() + i)));
    const label = sessionOptionLabel(session, finds);
    expect(label.length).toBeLessThanOrEqual(100);
    expect(label.startsWith("#1 · 1m · 🔥")).toBe(true);
});
