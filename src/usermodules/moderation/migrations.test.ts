import { expect, test } from "bun:test";
import { MODERATION_SCHEMA } from "./migrations";

test("the schema creates the four tables", () => {
    for (const table of ["mod_cases", "mod_case_events", "mod_settings", "mod_thresholds"]) {
        expect(MODERATION_SCHEMA).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
    }
});

test("the CHECK constraints restrict kinds, end reasons, event kinds and actions", () => {
    expect(MODERATION_SCHEMA).toMatch(
        /kind\s+VARCHAR\(10\) NOT NULL CHECK \(kind IN \('warn', 'mute', 'kick', 'ban', 'softban', 'temprole'\)\)/,
    );
    expect(MODERATION_SCHEMA).toMatch(/CHECK \(end_reason IN \('expired', 'revoked', 'replaced'\)\)/);
    expect(MODERATION_SCHEMA).toMatch(/'reason_changed', 'auto_undone'\)/);
    expect(MODERATION_SCHEMA).toMatch(/CHECK \(action IN \('mute', 'kick', 'ban'\)\)/);
});

test("the due index is partial on open cases", () => {
    expect(MODERATION_SCHEMA).toMatch(/mod_cases_due_idx ON mod_cases \(expires_at\) WHERE ended_at IS NULL/);
});

test("every CREATE statement is idempotent", () => {
    const creates = MODERATION_SCHEMA.match(/CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\b[^;]*/gi) ?? [];
    expect(creates.length).toBe(8);
    for (const stmt of creates) expect(stmt).toMatch(/IF NOT EXISTS/i);
});
