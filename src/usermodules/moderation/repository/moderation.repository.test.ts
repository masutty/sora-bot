import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import * as connection from "@/database/connection";
import * as cases from "./cases.repository";
import * as settingsRepo from "./settings.repository";

const calls: Array<{ sql: string; params: unknown[] }> = [];
let script: Array<{ match: string; rows: unknown[] }> = [];

const run = async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    const rows = script.find((entry) => sql.includes(entry.match))?.rows ?? [];
    return { rows, rowCount: rows.length };
};

/* Spies, not mock.module: bun shares one module registry across test files. */
const spies: Array<{ mockRestore: () => void }> = [];
beforeAll(() => {
    spies.push(spyOn(connection, "query").mockImplementation(run as never));
    spies.push(
        spyOn(connection, "transaction").mockImplementation((async (fn: (client: unknown) => unknown) => fn({ query: run })) as never),
    );
});
afterAll(() => {
    for (const spy of spies) spy.mockRestore();
});
beforeEach(() => {
    calls.length = 0;
    script = [];
});

test("insertCase passes every column in order and defaults the optional ones", async () => {
    script = [{ match: "INSERT INTO mod_cases", rows: [{ id: "K7XQ2MP" }] }];
    const row = await cases.insertCase({ id: "K7XQ2MP", guild_id: "g1", kind: "warn", user_id: "u1", moderator_id: "m1", reason: "spam" });
    expect(row).toMatchObject({ id: "K7XQ2MP" });
    expect(calls[0]?.params).toEqual(["K7XQ2MP", "g1", "warn", "u1", "m1", "spam", 1, null, null, null, null, null, null, null]);
});

test("insertCase keeps a null moderator for the bot and the Auto-Punishment link", async () => {
    script = [{ match: "INSERT INTO mod_cases", rows: [{}] }];
    const at = new Date(1000);
    await cases.insertCase({
        id: "AAAAAAA",
        guild_id: "g1",
        kind: "mute",
        user_id: "u1",
        moderator_id: null,
        reason: "Reached 3 active warns",
        expires_at: at,
        triggered_by: "BBBBBBB",
        threshold_level: 3,
        dm_delivered: true,
    });
    expect(calls[0]?.params).toEqual([
        "AAAAAAA",
        "g1",
        "mute",
        "u1",
        null,
        "Reached 3 active warns",
        1,
        null,
        null,
        at,
        "BBBBBBB",
        3,
        true,
        null,
    ]);
});

test("endCase only touches open cases and passes the end details", async () => {
    const at = new Date(5);
    script = [{ match: "UPDATE mod_cases SET ended_at", rows: [{ id: "K7XQ2MP" }] }];
    expect(await cases.endCase("K7XQ2MP", { reason: "revoked", by: "m1", note: "oops", at })).toMatchObject({ id: "K7XQ2MP" });
    expect(calls[0]?.sql).toContain("AND ended_at IS NULL");
    expect(calls[0]?.params).toEqual(["K7XQ2MP", at, "revoked", "m1", "oops"]);
    script = [];
    expect(await cases.endCase("K7XQ2MP", { reason: "expired", by: null, note: null, at })).toBeNull();
});

test("updateReason and getCase pass their keys", async () => {
    script = [{ match: "UPDATE mod_cases SET reason", rows: [{ id: "K7XQ2MP" }] }];
    await cases.updateReason("K7XQ2MP", "new");
    expect(calls[0]?.params).toEqual(["K7XQ2MP", "new"]);
    expect(await cases.getCase("g1", "NOPE")).toBeNull();
    expect(calls[1]?.params).toEqual(["g1", "NOPE"]);
});

test("insertEvent serialises data as JSON and listEvents orders by id", async () => {
    script = [{ match: "INSERT INTO mod_case_events", rows: [{ id: "1" }] }];
    await cases.insertEvent({ caseId: "K7XQ2MP", kind: "reason_changed", byId: "m1", data: { from: "a", to: "b" } });
    expect(calls[0]?.params).toEqual(["K7XQ2MP", "reason_changed", "m1", '{"from":"a","to":"b"}', null]);
    await cases.listEvents("K7XQ2MP");
    expect(calls[1]?.sql).toContain("ORDER BY id");
});

test("activeWarns excludes ended and past-expiry warns", async () => {
    const now = new Date(10);
    await cases.activeWarns("g1", "u1", now);
    expect(calls[0]?.sql).toContain("ended_at IS NULL AND (expires_at IS NULL OR expires_at > $3)");
    expect(calls[0]?.params).toEqual(["g1", "u1", now]);
});

test("activeOfKind, dueCases and listUserCases pass their parameters", async () => {
    const now = new Date(10);
    await cases.activeOfKind("g1", "u1", "mute");
    await cases.dueCases(now, 50);
    await cases.listUserCases("g1", "u1", { limit: 8, offset: 16 });
    expect(calls[0]?.params).toEqual(["g1", "u1", "mute"]);
    expect(calls[1]?.params).toEqual([now, 50]);
    expect(calls[2]?.sql).toContain("ORDER BY created_at DESC");
    expect(calls[2]?.params).toEqual(["g1", "u1", 8, 16]);
});

test("staffStats converts counts to numbers and passes null for all staff / all time", async () => {
    script = [{ match: "GROUP BY kind", rows: [{ kind: "warn", bot: false, count: "4" }] }];
    expect(await cases.staffStats("g1", null, null)).toEqual([{ kind: "warn", bot: false, count: 4 }]);
    expect(calls[0]?.params).toEqual(["g1", null, null]);
});

test("getSettings returns the defaults when the guild has no row", async () => {
    expect(await settingsRepo.getSettings("g1")).toEqual({
        guild_id: "g1",
        case_channel_id: null,
        warn_expiry_days: 30,
        auto_enabled: false,
        auto_undo: true,
        appeal_line: null,
        moderator_role_id: null,
    });
});

test("updateSettings upserts only the given columns and null clears one", async () => {
    script = [{ match: "INSERT INTO mod_settings", rows: [{ guild_id: "g1" }] }];
    await settingsRepo.updateSettings("g1", { case_channel_id: null, auto_enabled: true, appeal_line: undefined });
    expect(calls[0]?.sql).toContain("(guild_id, case_channel_id, auto_enabled) VALUES ($1, $2, $3)");
    expect(calls[0]?.sql).toContain("SET case_channel_id = $2, auto_enabled = $3");
    expect(calls[0]?.params).toEqual(["g1", null, true]);
});

test("getThresholds maps rows to the Threshold shape", async () => {
    script = [{ match: "FROM mod_thresholds", rows: [{ warns: 1, action: "mute", duration_s: 3600 }] }];
    expect(await settingsRepo.getThresholds("g1")).toEqual([{ warns: 1, action: "mute", durationS: 3600 }]);
});

test("replaceThresholds deletes the old ladder then inserts the new one", async () => {
    await settingsRepo.replaceThresholds("g1", [
        { warns: 2, action: "mute", durationS: 60 },
        { warns: 3, action: null, durationS: null },
    ]);
    expect(calls.map((c) => c.sql.trim().split(" ")[0])).toEqual(["DELETE", "INSERT", "INSERT"]);
    expect(calls[2]?.params).toEqual(["g1", 3, null, null]);
});
