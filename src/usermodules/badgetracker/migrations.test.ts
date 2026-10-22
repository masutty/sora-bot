import { expect, test } from "bun:test";
import { BADGE_TRACKER_SCHEMA } from "./migrations";

test("the schema creates the four bt_ tables", () => {
    for (const table of ["bt_badges", "bt_guilds", "bt_subscriptions", "bt_settings"]) {
        expect(BADGE_TRACKER_SCHEMA).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
    }
});

test("every CREATE statement is idempotent", () => {
    const creates = BADGE_TRACKER_SCHEMA.match(/CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\b[^;]*/gi) ?? [];
    expect(creates.length).toBeGreaterThanOrEqual(5);
    for (const stmt of creates) expect(stmt).toMatch(/IF NOT EXISTS/i);
});
