import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import * as realConnection from "@/database/connection";

interface Call {
    sql: string;
    params: unknown[];
}

let calls: Call[] = [];
let biomeCount = 0;
let sessionRowsDeleted = 0;

function respond(sql: string, params: unknown[] = []) {
    calls.push({ sql, params });
    if (sql.includes("FROM bh_users WHERE guild_id")) return { rows: [{ id: 7, guild_id: "g", discord_user_id: "u" }], rowCount: 1 };
    if (sql.includes("FROM bh_users WHERE id")) {
        if (sql.includes("FOR UPDATE")) return { rows: [{ seeds: 120, xp: 340 }], rowCount: 1 };
        return { rows: [{ id: 7, guild_id: "g", discord_user_id: "u" }], rowCount: 1 };
    }
    if (sql.includes("FROM bh_guild_badge_roles")) return { rows: [{ badge: "GLITCHED", role_id: "role-badge" }], rowCount: 1 };
    if (sql.includes("DELETE FROM bh_user_badges")) return { rows: [{ badge: "GLITCHED" }, { badge: "other" }], rowCount: 2 };
    if (sql.includes("DELETE FROM bh_user_quota_roles")) return { rows: [{ role_id: "role-quota" }], rowCount: 1 };
    if (sql.includes("DELETE FROM bh_activity_events") && sql.includes("RETURNING event_type")) {
        return { rows: [{ event_type: "started" }, { event_type: "ended" }, { event_type: "started" }], rowCount: 3 };
    }
    if (sql.includes("DELETE FROM bh_activity_sessions")) return { rows: [], rowCount: sessionRowsDeleted };
    if (sql.includes("COUNT(*) AS count FROM bh_activity_events")) return { rows: [{ count: String(biomeCount) }], rowCount: 1 };
    if (sql.includes("INSERT INTO bh_activity_events")) return { rows: [{ id: 1 }, { id: 2 }], rowCount: 2 };
    if (sql.includes("DELETE FROM bh_activity_events")) return { rows: [{ id: 1 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
}

mock.module("@/database/connection", () => ({
    ...realConnection,
    query: async (sql: string, params?: unknown[]) => respond(sql, params),
}));

const fakeTransaction = (async (fn: (c: unknown) => Promise<unknown>) =>
    fn({ query: async (sql: string, params?: unknown[]) => respond(sql, params) })) as unknown as typeof realConnection.transaction;

import { deleteSessions, resetMemberProgress, setBiomeCount } from "./member.service";

afterAll(() => mock.module("@/database/connection", () => realConnection));
beforeEach(() => {
    calls = [];
    biomeCount = 0;
    sessionRowsDeleted = 0;
});

const sqlOf = () => calls.map((c) => c.sql).join("\n");

test("resetMemberProgress: returns totals counted before deleting", async () => {
    sessionRowsDeleted = 4;
    expect(await resetMemberProgress("g", "u", fakeTransaction)).toEqual({ sessions: 4, finds: 2, badges: 2, seeds: 120, xp: 340 });
});

test("resetMemberProgress: zeroes seeds and xp, never touches the macro channel or flower", async () => {
    await resetMemberProgress("g", "u", fakeTransaction);
    const sql = sqlOf();
    expect(sql).toContain("SET seeds = 0, xp = 0");
    expect(sql).not.toContain("bh_user_macro_channels");
    expect(sql).not.toContain("flower");
    expect(sql).not.toContain("DELETE FROM bh_users");
});

test("resetMemberProgress: queues removal of held badge and quota roles", async () => {
    await resetMemberProgress("g", "u", fakeTransaction);
    const jobs = calls.filter((c) => c.sql.includes("INSERT INTO bh_role_jobs")).map((c) => c.params.slice(0, 4));
    expect(jobs).toEqual([
        ["g", 7, "role-quota", "remove"],
        ["g", 7, "role-badge", "remove"],
    ]);
});

test("deleteSessions: scopes the delete to the user and skips an empty list", async () => {
    sessionRowsDeleted = 1;
    expect(await deleteSessions(7, [1, 2])).toBe(1);
    expect(calls[0].params).toEqual([7, [1, 2]]);
    calls = [];
    expect(await deleteSessions(7, [])).toBe(0);
    expect(calls).toHaveLength(0);
});

test("setBiomeCount: adds the difference when going up", async () => {
    biomeCount = 3;
    await setBiomeCount(7, "GLITCHED", 5);
    const insert = calls.find((c) => c.sql.includes("INSERT INTO bh_activity_events"));
    expect((insert?.params[2] as string[]).length).toBe(2);
});

test("setBiomeCount: removes the difference when going down", async () => {
    biomeCount = 5;
    await setBiomeCount(7, "GLITCHED", 2);
    const del = calls.find((c) => c.sql.includes("DELETE FROM bh_activity_events"));
    expect(del?.params).toEqual([7, "GLITCHED", 3]);
});

test("setBiomeCount: does nothing when the count already matches", async () => {
    biomeCount = 4;
    await setBiomeCount(7, "GLITCHED", 4);
    expect(calls.some((c) => c.sql.includes("INSERT") || c.sql.includes("DELETE"))).toBe(false);
});
