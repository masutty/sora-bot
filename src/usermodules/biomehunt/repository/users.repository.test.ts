import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import * as realConnection from "@/database/connection";
import { NOT_FAKE_SQL } from "./activity.repository";

const calls: Array<{ sql: string; params: unknown[] }> = [];
let rows: unknown[] = [];

mock.module("@/database/connection", () => ({
    ...realConnection,
    query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return { rows, rowCount: rows.length };
    },
}));

import type * as Repo from "./users.repository";

let repo: typeof Repo;
beforeAll(async () => {
    repo = await import("./users.repository");
});

afterAll(() => mock.module("@/database/connection", () => realConnection));

test("open votes don't count until closed", async () => {
    calls.length = 0;
    rows = [
        { user_id: 1, biome: "GLITCHED", count: "3" },
        { user_id: 1, biome: "DREAMSPACE", count: "1" },
    ];
    const counts = await repo.getClosedRareCounts([1, 2]);
    const { sql, params } = calls[0];
    expect(sql).toContain(NOT_FAKE_SQL);
    expect(sql).toContain("v.status = 'open'");
    expect(sql).toContain("MAX(v2.created_at)");
    expect(params[0]).toEqual([1, 2]);
    expect(counts.get(1)).toEqual([
        { biome: "GLITCHED", count: 3 },
        { biome: "DREAMSPACE", count: 1 },
    ]);
});

test("getClosedRareCounts skips the query for no users", async () => {
    calls.length = 0;
    expect((await repo.getClosedRareCounts([])).size).toBe(0);
    expect(calls).toHaveLength(0);
});

test("setNameBadges stores the badges and the rename time", async () => {
    calls.length = 0;
    await repo.setNameBadges(4, "🔥3");
    expect(calls[0].sql).toContain("name_renamed_at = NOW()");
    expect(calls[0].params).toEqual([4, "🔥3"]);
});

test("getChannelNameCandidates reads the flag per guild", async () => {
    calls.length = 0;
    rows = [{ user_id: 1, guild_id: "g", channel_id: "c", name_badges: "🔥3", name_renamed_at: null, flag_on: false }];
    expect(await repo.getChannelNameCandidates()).toEqual([
        { userId: 1, guildId: "g", channelId: "c", nameBadges: "🔥3", renamedAt: null, flagOn: false },
    ]);
    expect(calls[0].sql).toContain("RARE_COUNT_IN_CHANNEL_NAME");
});
