import { expect, test } from "bun:test";
import { NO_PINGS } from "@/utils/format";
import { settings } from "../settings";
import type { CaseEventRow, CaseRow } from "../types";
import { caseDetailReply, caseLine } from "./case.render";

const row = (over: Partial<CaseRow> = {}): CaseRow => ({
    id: "MUQTQDB",
    guild_id: "g1",
    kind: "warn",
    user_id: "u1",
    moderator_id: "m1",
    reason: "test reason",
    weight: 1,
    role_id: null,
    created_at: new Date(1_700_000_000_000),
    expires_at: null,
    ended_at: null,
    end_reason: null,
    ended_by: null,
    end_note: null,
    triggered_by: null,
    threshold_level: null,
    dm_delivered: null,
    dm_error: null,
    ...over,
});

const event = (kind: CaseEventRow["kind"], by_id: string | null, data: Record<string, unknown> = {}): CaseEventRow => ({
    id: "1",
    case_id: "MUQTQDB",
    kind,
    by_id,
    data,
    at: new Date(1_700_000_100_000),
});

const json = (reply: ReturnType<typeof caseDetailReply>) => JSON.parse(JSON.stringify(reply.components[0]));
const texts = (reply: ReturnType<typeof caseDetailReply>): string[] =>
    json(reply)
        .components.filter((c: { type: number }) => c.type === 10)
        .map((c: { content: string }) => c.content);

test("a list line is a bullet with the reason and the time on quote lines", () => {
    expect(caseLine(row({ weight: 3 }))).toBe("- `MUQTQDB` **Warn** 3x (active)\n> test reason\n> <t:1700000000:R>");
    expect(caseLine(row({ ended_at: new Date(), end_reason: "revoked" }))).toContain("(revoked)");
});

test("the detail has a header, details and history split by dividers", () => {
    const reply = caseDetailReply(
        row({ weight: 3, expires_at: new Date(1_700_100_000_000), dm_delivered: false, dm_error: "DMs closed" }),
        [event("created", "m1"), event("revoked", "m2", { note: "oops" })],
    );
    const [header, reason, details, history] = texts(reply);
    expect(reply.allowedMentions).toBe(NO_PINGS);
    expect(json(reply).components.filter((c: { type: number }) => c.type === 14)).toHaveLength(3);
    expect(header).toBe("**Warn** `MUQTQDB`\n-# Active\n<@u1>, warned by <@m1>");
    expect(reason).toBe("**Reason**\n>>> test reason");
    expect(details).toContain("- **Weight:** 3x");
    expect(details).toContain("- **Expires:** <t:");
    expect(details).toContain("`❌ Not delivered (DMs closed)`");
    expect(history).toContain("- Created by <@m1>\n> <t:1700000100:R>");
    expect(history).toContain("- Revoked by <@m2>\n> <t:1700000100:R>\n> **Reason:** oops");
    for (const t of [header, reason, details, history]) expect(t).not.toContain("·");
});

test("a revoked case says who revoked it under the title", () => {
    const header = texts(caseDetailReply(row({ ended_at: new Date(), end_reason: "revoked", ended_by: "m2" }), []))[0];
    expect(header).toContain("-# Revoked by <@m2>");
});

test("optional details are omitted and an Auto-Punishment is credited to it", () => {
    const [header, , details] = texts(caseDetailReply(row({ moderator_id: null }), [])) as string[];
    expect(header).toContain("<@u1>, warned by Auto-Punishment");
    for (const label of ["Expires", "Weight", "Role", "Triggered by", "DM"]) expect(details).not.toContain(`**${label}:**`);
});

test("the accent follows the kind, and an ended case is grey", () => {
    expect(json(caseDetailReply(row(), [])).accent_color).toBe(settings.warnColor);
    expect(json(caseDetailReply(row({ kind: "ban" }), [])).accent_color).toBe(settings.punishColor);
    expect(json(caseDetailReply(row({ kind: "temprole" }), [])).accent_color).toBe(settings.accentColor);
    expect(json(caseDetailReply(row({ ended_at: new Date(), end_reason: "expired" }), [])).accent_color).toBe(settings.endedColor);
});
