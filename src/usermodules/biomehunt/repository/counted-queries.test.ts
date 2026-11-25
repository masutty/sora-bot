import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Listing queries that show uncounted sessions too. Every other query on bh_activity_sessions must filter on `counted`. */
const ALLOWED = [
    "getLatestSession",
    "getLatestSessionForUser",
    "getSessionInGuild",
    "getSessionsCovering",
    "getRecentSessions",
    "getGuildRareSessions",
    // Session management (count, reset preview, clear all) must see and delete uncounted sessions too.
    "countSessionsForUser",
];
const ALLOWED_PREFIXES = ["deleteSession", "deleteAllSessionsForUser"];

const SESSIONS_TABLE = /(FROM|JOIN)\s+bh_activity_sessions/;

/** Splits a source file into `[functionName, body]` chunks; code before the first function is `<module>`. */
function chunks(source: string): Array<[string, string]> {
    const starts = [...source.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm)];
    const result: Array<[string, string]> = [["<module>", source.slice(0, starts[0]?.index ?? source.length)]];
    for (const [i, m] of starts.entries()) result.push([m[1], source.slice(m.index, starts[i + 1]?.index ?? source.length)]);
    return result;
}

test("every query on bh_activity_sessions filters on counted unless it is an allow-listed listing", () => {
    const missing: string[] = [];
    for (const file of ["activity.repository.ts", "leaderboard.repository.ts"]) {
        const source = readFileSync(join(__dirname, file), "utf8");
        for (const [name, body] of chunks(source)) {
            if (!SESSIONS_TABLE.test(body) || /\bcounted\b/.test(body)) continue;
            if (ALLOWED.includes(name) || ALLOWED_PREFIXES.some((p) => name.startsWith(p))) continue;
            missing.push(`${file}: ${name}`);
        }
    }
    expect(missing).toEqual([]);
});
