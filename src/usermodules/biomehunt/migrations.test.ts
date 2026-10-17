import { expect, test } from "bun:test";
import { BIOMEHUNT_SCHEMA } from "./migrations";

/** The schema's SQL with its comments stripped - so the rule below checks statements, not prose. */
const sql = BIOMEHUNT_SCHEMA.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

// The whole schema re-runs every time any part of it changes (see migrate.ts's hash check), so a
// flag write here would repeat on every such deploy - that once turned AUTO_DELETE_ENABLED on or
// off for every server at once, and auto-delete has deleted real users' macro channels before.
test("the schema never writes bh_guild_flags", () => {
    expect(sql).not.toMatch(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+bh_guild_flags\b/i);
});

test("the schema still creates bh_guild_flags", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS bh_guild_flags/);
});
