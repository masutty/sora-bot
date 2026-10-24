import { expect, test } from "bun:test";
import { ContainerBuilder } from "discord.js";
import { createFakeViewTransport, type ViewPayload } from "@/define";
import { type ActivityStatus, type GuildRareFind, type UserRow, VoteStatus } from "../types";
import { type BiomesStatsInput, biomesStatsView, type UsersStatsInput, usersStatsView } from "./stats.view";

const OWNER = "owner";

function fakeUser(id: number): UserRow {
    return {
        id,
        guild_id: "g1",
        discord_user_id: String(id),
        current_status: "active",
        last_activity_at: null,
        activity_grace_until: null,
        activity_grace_biome: null,
        paused_at: null,
        created_at: new Date(),
        seeds: 0,
        xp: 0,
        flower: null,
    };
}

function fakeInput(): UsersStatsInput {
    const active: UserRow[] = Array.from({ length: 15 }, (_, i) => fakeUser(i + 1));
    const usersByStatus: Record<ActivityStatus, UserRow[]> = { active, idle: [], inactive: [] };
    return { overview: new ContainerBuilder(), usersByStatus };
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

test("biomehunt.stats-users: a stale prev/next click after switching to Overview is a no-op, not a throw", async () => {
    const fake = createFakeViewTransport();
    void fake.run(usersStatsView, fakeInput(), OWNER);
    await fake.flush();

    await fake.emit(fake.click("tab:active", OWNER));
    // Grab the "next" customId BEFORE switching away - simulates a click that lands after the
    // message already moved on (a stale/racing interaction), not a click on the current render.
    const staleNext = fake.id("next");

    await fake.emit(fake.click("tab:overview", OWNER));

    // Same session, same message: re-dispatch the stale customId. Must not throw (the engine
    // catching it and showing a generic "something went wrong" quip is still a regression - it
    // should be a silent no-op, so assert nothing was notified at all).
    await fake.emit(fake.clickId(staleNext, OWNER));

    expect(fake.closed).toBe(0);
    expect(fake.notifies).toHaveLength(0);
    // Still showing the Overview tab's content, untouched by the stale click.
    expect(text(fake.lastPayload())).not.toContain("Page");
});

test("biomehunt.stats-users: disableActive is off - reclicking the active status tab still resets to page 1", async () => {
    const fake = createFakeViewTransport();
    void fake.run(usersStatsView, fakeInput(), OWNER);
    await fake.flush();

    await fake.emit(fake.click("tab:active", OWNER));
    await fake.emit(fake.click("next", OWNER));
    expect(text(fake.lastPayload())).toContain("Page 2");

    // Reclicking the already-active "active" tab is possible (not disabled) and resets the page.
    await fake.emit(fake.click("tab:active", OWNER));
    expect(text(fake.lastPayload())).toContain("Page 1");
});

function raresInput(finds: GuildRareFind[]): BiomesStatsInput {
    return {
        overview: new ContainerBuilder(),
        contributors: new ContainerBuilder(),
        rares: {
            guildId: "g1",
            finds,
            sessions: [],
            macroSeconds: { week: 3600, month: 3600, all: 7200 },
            now: new Date("2026-10-23T12:00:00Z"),
        },
    };
}

const rareFind = (user: string, at: string, status: VoteStatus): GuildRareFind => ({
    eventId: 1,
    biome: "GLITCHED",
    at: new Date(at),
    macroMessageId: "m",
    macroChannelId: "c",
    vote: { id: "v", status, decidedBy: null, channelId: "fc", messageId: "fm", jumpLink: "https://j", real: 1, fake: 0 },
    userId: 1,
    discordUserId: user,
});

test("biomehunt.stats-biomes: the Rares tab switches section and period, and shows the empty period", async () => {
    const fake = createFakeViewTransport();
    void fake.run(biomesStatsView, raresInput([rareFind("u1", "2026-09-01T00:00:00Z", VoteStatus.COMMUNITY_REAL)]), OWNER);
    await fake.flush();

    await fake.emit(fake.click("tab:rares", OWNER));
    expect(text(fake.lastPayload())).toContain("## 💎 Rare Finds");
    expect(text(fake.lastPayload())).toContain("**Top finders**");

    for (const [section, title] of [
        ["quality", "Rare Quality"],
        ["members", "Rare Finders"],
        ["pace", "Rare Pace"],
        ["records", "Rare Records"],
    ]) {
        await fake.emit(fake.click("rare-section", OWNER, [section]));
        expect(text(fake.lastPayload())).toContain(`## 💎 ${title}`);
    }

    await fake.emit(fake.click("rare-period", OWNER, ["week"]));
    expect(text(fake.lastPayload())).toContain("No rare finds in the last 7 days.");
    expect(fake.notifies).toHaveLength(0);
});

test("biomehunt.stats-biomes: Members pages 10 finders at a time", async () => {
    const finds = Array.from({ length: 12 }, (_, i) => rareFind(`u${i}`, "2026-10-20T00:00:00Z", VoteStatus.COMMUNITY_REAL));
    const fake = createFakeViewTransport();
    void fake.run(biomesStatsView, raresInput(finds), OWNER);
    await fake.flush();

    await fake.emit(fake.click("tab:rares", OWNER));
    await fake.emit(fake.click("rare-section", OWNER, ["members"]));
    expect(text(fake.lastPayload()).match(/<@u\d+>/g)).toHaveLength(10);
    await fake.emit(fake.click("next", OWNER));
    expect(text(fake.lastPayload()).match(/<@u\d+>/g)).toHaveLength(2);
});
