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

// Same reason: the non-rare delayed-forward cleanup must run once, and never against an empty
// bh_biomes (it's seeded after the schema runs), or it would drop every delayed forward.
test("the delayed-forward cleanup runs once and only once bh_biomes has rows", () => {
    const deletes = sql.match(/DELETE\s+FROM\s+bh_biome_delayed_forwards/gi) ?? [];
    expect(deletes).toHaveLength(1);
    const block = sql.slice(sql.lastIndexOf("DO $$", sql.search(/DELETE\s+FROM\s+bh_biome_delayed_forwards/i)));
    expect(block).toMatch(/NOT EXISTS \(SELECT 1 FROM bh_data_migrations WHERE name = 'delayed-forwards-rare-only'\)/);
    expect(block).toMatch(/EXISTS \(SELECT 1 FROM bh_biomes\)/);
    expect(block).toMatch(/INSERT INTO bh_data_migrations \(name\) VALUES \('delayed-forwards-rare-only'\)/);
});

test("the schema still creates bh_guild_flags", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS bh_guild_flags/);
});
