import { expect, test } from "bun:test";
import type { QuotaDayReport } from "../services/quota-report.service";
import type { QuotaRoleRow } from "../types";
import { buildQuotaDayContainer } from "./quota-report.view";

type Json = { content?: string; components?: Json[] };
const textOf = (json: Json): string => [json.content ?? "", ...(json.components ?? []).map(textOf)].filter(Boolean).join("\n");

const ROLE = {
    id: 1,
    guild_id: "g1",
    role_id: "role-1",
    mode: "F",
    quota_target_seconds: 3 * 3600,
    quota_window_hours: 24,
} as QuotaRoleRow;
const START = new Date("2026-09-29T21:00:00Z");
const END = new Date("2026-09-30T21:00:00Z");

function report(overrides: Partial<QuotaDayReport> = {}): QuotaDayReport {
    return {
        start: START,
        end: END,
        inProgress: false,
        roles: [
            {
                role: ROLE,
                hit: [{ discordUserId: "a", activeSeconds: 5 * 3600 + 12 * 60 }],
                missed: [
                    { discordUserId: "b", activeSeconds: 2 * 3600 + 40 * 60 },
                    { discordUserId: "c", activeSeconds: 0 },
                ],
            },
        ],
        ...overrides,
    };
}

test("the card says which window it covers (Discord timestamps, ending on the window's last minute)", () => {
    const text = textOf(buildQuotaDayContainer(report(), "Yesterday").toJSON() as Json);
    expect(text).toContain("## Quotas · Yesterday");
    expect(text).toContain(`from <t:${START.getTime() / 1000}:f> to <t:${END.getTime() / 1000 - 60}:f>`);
});

test("a finished day: role heading + target, then Hit and Missed groups with members quoted under them", () => {
    const text = textOf(buildQuotaDayContainer(report(), "Yesterday").toJSON() as Json);
    expect(text).toContain("### <@&role-1>\n-# Target: `3h` per day");
    expect(text).toContain("- `✅ Hit · 1`\n> <@a> `5h 12m`");
    expect(text).toContain("- `❌ Missed · 2`\n> <@b> `2h 40m / 3h` · <@c> `0m / 3h`");
});

test("today: 'Not yet' instead of 'Missed', and no 'in progress' line", () => {
    const text = textOf(buildQuotaDayContainer(report({ inProgress: true }), "Today").toJSON() as Json);
    expect(text).toContain("- `⏳ Not yet · 2`");
    expect(text).not.toContain("Missed");
    expect(text).not.toContain("in progress");
});

test("an empty group reads 'Nobody'", () => {
    const r = report();
    r.roles[0].missed = [];
    expect(textOf(buildQuotaDayContainer(r, "Yesterday").toJSON() as Json)).toContain("- `❌ Missed · 0`\n> -# Nobody");
});

test("a role whose own window isn't 24h gets a warning", () => {
    const r = report();
    r.roles[0].role = { ...ROLE, quota_window_hours: 48 };
    expect(textOf(buildQuotaDayContainer(r, "Today").toJSON() as Json)).toContain("really counts the last 48h");
});

test("long lists are cut with '+N more'; no roles shows a hint", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ discordUserId: `u${i}`, activeSeconds: 4 * 3600 }));
    const r = report();
    r.roles[0].hit = many;
    expect(textOf(buildQuotaDayContainer(r, "Today").toJSON() as Json)).toContain("+5 more");
    expect(textOf(buildQuotaDayContainer(report({ roles: [] }), "Today").toJSON() as Json)).toContain("No quota roles configured");
});
