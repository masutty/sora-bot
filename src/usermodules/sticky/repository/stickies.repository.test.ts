import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import * as connection from "@/database/connection";
import * as limits from "./limits.repository";
import * as repo from "./stickies.repository";

const calls: Array<{ sql: string; params: unknown[] }> = [];
let script: Array<{ match: string; rows: unknown[] }> = [];

const run = async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    const rows = script.find((entry) => sql.includes(entry.match))?.rows ?? [];
    return { rows, rowCount: rows.length };
};

/* A spy, not mock.module: bun shares one module registry across test files. */
let spy: { mockRestore: () => void };
beforeAll(() => {
    spy = spyOn(connection, "query").mockImplementation(run as never);
});
afterAll(() => spy.mockRestore());
beforeEach(() => {
    calls.length = 0;
    script = [];
});

test("insertSticky passes every column in order and returns the row", async () => {
    script = [{ match: "INSERT INTO sm_stickies", rows: [{ channel_id: "c1" }] }];
    const row = await repo.insertSticky({
        guild_id: "g1",
        channel_id: "c1",
        content: "hi",
        mode: "all",
        delay_seconds: 300,
        created_by: "u1",
    });
    expect(row).toMatchObject({ channel_id: "c1" });
    expect(calls[0]?.params).toEqual(["g1", "c1", "hi", "all", 300, "u1"]);
});

test("updateSticky builds only the given columns", async () => {
    script = [{ match: "UPDATE sm_stickies", rows: [{ channel_id: "c1" }] }];
    await repo.updateSticky("c1", { content: "new", message_id: null });
    expect(calls[0]?.sql).toContain("SET content = $2, message_id = $3 WHERE channel_id = $1");
    expect(calls[0]?.params).toEqual(["c1", "new", null]);
});

test("updateSticky skips undefined values and returns null for a missing row", async () => {
    expect(await repo.updateSticky("c1", { mode: "nobots", delay_seconds: undefined })).toBeNull();
    expect(calls[0]?.sql).not.toContain("delay_seconds");
});

test("deleteSticky returns the deleted row or null", async () => {
    script = [{ match: "DELETE FROM sm_stickies", rows: [{ channel_id: "c1", message_id: "m1" }] }];
    expect(await repo.deleteSticky("c1")).toMatchObject({ message_id: "m1" });
    expect(calls[0]?.params).toEqual(["c1"]);
    script = [];
    expect(await repo.deleteSticky("c2")).toBeNull();
});

test("countGuildStickies and guildUsage convert counts to numbers", async () => {
    script = [{ match: "WHERE guild_id", rows: [{ count: "4" }] }];
    expect(await repo.countGuildStickies("g1")).toBe(4);
    script = [{ match: "GROUP BY", rows: [{ guild_id: "g1", count: "2" }] }];
    expect(await repo.guildUsage()).toEqual([{ guild_id: "g1", count: 2 }]);
});

test("getGuildLimit falls back to the default limit, then to the setting", async () => {
    script = [{ match: "sm_guild_limits", rows: [{ max_stickies: 9 }] }];
    expect(await limits.getGuildLimit("g1")).toBe(9);
    script = [{ match: "sm_settings", rows: [{ default_limit: 7 }] }];
    expect(await limits.getGuildLimit("g1")).toBe(7);
    script = [];
    expect(await limits.getGuildLimit("g1")).toBe(5);
});

test("setGuildLimit null deletes the override, a number upserts it", async () => {
    await limits.setGuildLimit("g1", null);
    expect(calls[0]?.sql).toContain("DELETE FROM sm_guild_limits");
    await limits.setGuildLimit("g1", 12);
    expect(calls[1]?.sql).toContain("ON CONFLICT (guild_id)");
    expect(calls[1]?.params).toEqual(["g1", 12]);
});
