import { expect, test } from "bun:test";
import { createFakeViewTransport, type ViewPayload } from "@/define";
import type { QuotaDayReport, QuotaMember } from "../services/quota-report.service";
import { hitCount } from "../services/quota-report.service";
import type { QuotaRoleRow } from "../types";
import { buildQuotaDayContainer, quotaPageCount, quotaStatsView } from "./quota-report.view";

type Json = { content?: string; custom_id?: string; disabled?: boolean; components?: Json[] };
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
const H = 3600;

/** `hits` members above the 3h target, then `misses` below it - most active first, like the service returns. */
function members(hits: number, misses: number): QuotaMember[] {
    return [
        ...Array.from({ length: hits }, (_, i) => ({ discordUserId: `hit${i}`, activeSeconds: 10 * H - i * 60 })),
        ...Array.from({ length: misses }, (_, i) => ({ discordUserId: `miss${i}`, activeSeconds: 2 * H - i * 60 })),
    ];
}

function report(overrides: Partial<QuotaDayReport> = {}): QuotaDayReport {
    return { start: START, end: END, inProgress: false, roles: [ROLE], members: members(1, 2), ...overrides };
}

const card = (r: QuotaDayReport, page = 0, label = "Yesterday") => textOf(buildQuotaDayContainer(r, label, 0, page).toJSON() as Json);

test("hitCount: the members at or over the target, which are the first ones of the sorted list", () => {
    expect(hitCount(members(3, 4), 3 * H)).toBe(3);
    expect(hitCount(members(0, 4), 3 * H)).toBe(0);
    expect(hitCount(members(5, 0), 3 * H)).toBe(5);
});

test("the card says which window it covers, then the role and its target - no hit / missed totals up top", () => {
    const text = card(report());
    expect(text).toContain("## Quotas · Yesterday");
    expect(text).toContain(`from <t:${START.getTime() / 1000}:f> to <t:${END.getTime() / 1000 - 60}:f>`);
    expect(text).toContain("### <@&role-1>\n-# Target: `3h` per day\n");
    expect(text).not.toContain(" hit ·");
});

test("labelled groups, one member per line, the fixed-width time first", () => {
    const text = card(report());
    expect(text).toContain("- `✅ Hit · 1`\n> `10h 00m` <@hit0>");
    expect(text).toContain("- `❌ Missed · 2`\n> ` 2h 00m` <@miss0>\n> ` 1h 59m` <@miss1>");
});

test("today labels the second group 'Not yet' instead of 'Missed'", () => {
    const text = card(report({ inProgress: true }), 0, "Today");
    expect(text).toContain("- `⏳ Not yet · 2`");
    expect(text).not.toContain("Missed");
});

test("a group only shows when it has members on the page", () => {
    expect(card(report({ members: members(3, 0) }))).not.toContain("Missed");
    expect(card(report({ members: members(0, 3) }))).not.toContain("✅ Hit");
});

test("pages hold 20 members; a group's label shows on every page it spans, with its full count", () => {
    const r = report({ members: members(25, 10) });
    expect(quotaPageCount(r)).toBe(2);
    expect(card(r, 0)).toContain("- `✅ Hit · 25`");
    expect(card(r, 0)).toContain("<@hit19>");
    expect(card(r, 0)).not.toContain("<@hit20>");
    expect(card(r, 0)).not.toContain("Missed");
    expect(card(r, 1)).toContain("- `✅ Hit · 25`\n> ` 9h 40m` <@hit20>");
    expect(card(r, 1)).toContain("- `❌ Missed · 10`");
});

test("a role whose own window isn't 24h gets a warning; no members or no roles have their own text", () => {
    expect(card(report({ roles: [{ ...ROLE, quota_window_hours: 48 }] }))).toContain("really counts the last 48h");
    expect(card(report({ members: [] }))).toContain("-# Nobody");
    expect(card(report({ roles: [] }))).toContain("No quota roles configured");
});

function comp(payload: ViewPayload, key: string): Json {
    const walk = (node: unknown): Json[] => {
        const json = (typeof (node as { toJSON?: unknown })?.toJSON === "function" ? (node as { toJSON(): unknown }).toJSON() : node) as
            | Json
            | Json[];
        if (Array.isArray(json)) return json.flatMap(walk);
        if (!json || typeof json !== "object") return [];
        return [json, ...walk(json.components ?? [])];
    };
    const found = walk(payload.components).find((c) => c.custom_id?.endsWith(`:${key}`));
    if (!found) throw new Error(`No component "${key}"`);
    return found;
}

test("view: opens on today, switching day or role goes back to page 1, pagination only when needed", async () => {
    const roles = [ROLE, { ...ROLE, id: 2, role_id: "role-2" }];
    const today = report({ inProgress: true, roles, members: members(25, 10) });
    const yesterday = report({ roles, members: members(2, 3) });
    const fake = createFakeViewTransport();
    void fake.run(quotaStatsView, { reports: { today, yesterday }, roleNames: { "role-1": "Macro", "role-2": "Other" } }, "owner");
    await fake.flush();

    const text = () =>
        textOf({ components: (fake.lastPayload().components ?? []).map((c) => (c as unknown as { toJSON(): Json }).toJSON()) });
    expect(text()).toContain("## Quotas · Today");
    expect(comp(fake.lastPayload(), "day:today").disabled).toBe(true);

    await fake.emit(fake.click("next", "owner"));
    expect(text()).toContain("<@hit24>");

    await fake.emit(fake.click("role", "owner", ["1"]));
    expect(text()).toContain("### <@&role-2>");
    expect(text()).toContain("<@hit0>"); // back on page 1

    await fake.emit(fake.click("day:yesterday", "owner"));
    expect(text()).toContain("## Quotas · Yesterday");
    expect(() => comp(fake.lastPayload(), "next")).toThrow(); // 5 members - a single page, no pager
});
