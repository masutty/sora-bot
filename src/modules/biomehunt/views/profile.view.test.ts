import { expect, test } from "bun:test";
import type { GuildMember } from "discord.js";
import { createFakeViewTransport, type ViewPayload } from "@/define";
import type { ActivitySessionRow, UserRow } from "../types";
import { profileView } from "./profile.view";
import type { ProfileData } from "./stats-builders";

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
        flowersEnabled: false,
        economyEnabled: false,
        ...overrides,
    };
}

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

test("biomehunt.profile: sessionsNext/sessionsPrev page the Sessions tab, and switching tabs resets the page", async () => {
    const fake = createFakeViewTransport();
    void fake.run(profileView(fakeMember()), fakeData(), OWNER);
    await fake.flush();

    await fake.emit(fake.click("tab:sessions", OWNER));
    expect(text(fake.lastPayload())).toContain("Page 1 of 3");

    await fake.emit(fake.click("sessionsNext", OWNER));
    expect(text(fake.lastPayload())).toContain("Page 2 of 3");

    // Leaving and coming back to the Sessions tab resets its page, same as the old runProfileView.
    await fake.emit(fake.click("tab:profile", OWNER));
    await fake.emit(fake.click("tab:sessions", OWNER));
    expect(text(fake.lastPayload())).toContain("Page 1 of 3");
});
