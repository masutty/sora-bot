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

// A profile wipe must not cascade into the shop: purchases keep their row, grants are keyed by Discord id.
test("the shop tables survive a profile wipe", () => {
    const purchases = sql.slice(
        sql.indexOf("CREATE TABLE IF NOT EXISTS bh_shop_purchases"),
        sql.indexOf("CREATE INDEX IF NOT EXISTS idx_bh_shop_purchases_guild"),
    );
    expect(purchases).toMatch(/user_id\s+INTEGER REFERENCES bh_users\(id\) ON DELETE SET NULL/);
    const grants = sql.slice(
        sql.indexOf("CREATE TABLE IF NOT EXISTS bh_shop_role_grants"),
        sql.indexOf("CREATE INDEX IF NOT EXISTS idx_bh_shop_role_grants_ends"),
    );
    expect(grants).toMatch(/PRIMARY KEY \(guild_id, discord_user_id, role_id\)/);
    expect(grants).not.toMatch(/REFERENCES bh_users/);
});

// The shop tables of the first shape are moved by guarded statements, so the whole schema stays safe to re-run.
test("the shop migration steps are guarded", () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS role_window_start/);
    expect(sql).toMatch(/table_name = 'bh_shop_role_grants' AND column_name = 'user_id'/);
    expect(sql).toMatch(/IF fk IS NOT NULL THEN/);
});
