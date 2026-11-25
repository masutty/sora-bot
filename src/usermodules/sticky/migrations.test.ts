import { expect, test } from "bun:test";
import { STICKY_SCHEMA } from "./migrations";

test("the schema creates the three sm_ tables", () => {
    for (const table of ["sm_stickies", "sm_guild_limits", "sm_settings"]) {
        expect(STICKY_SCHEMA).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
    }
});

test("the mode column is restricted to all and nobots", () => {
    expect(STICKY_SCHEMA).toMatch(/CHECK \(mode IN \('all', 'nobots'\)\)/);
});

test("every CREATE statement is idempotent", () => {
    const creates = STICKY_SCHEMA.match(/CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\b[^;]*/gi) ?? [];
    expect(creates.length).toBe(4);
    for (const stmt of creates) expect(stmt).toMatch(/IF NOT EXISTS/i);
});
