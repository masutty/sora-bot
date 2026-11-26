import { expect, test } from "bun:test";
import { MessageFlags } from "discord.js";
import { NO_PINGS } from "@/utils/format";
import { settings } from "../settings";
import type { CaseRow } from "../types";
import { caseChannelPayload, dmPayload } from "./payloads";

const created = new Date("2026-01-01T00:00:00Z");
const T = Math.floor(created.getTime() / 1000);

function row(overrides: Partial<CaseRow>): CaseRow {
    return {
        id: "K7XQ2MP",
        guild_id: "g1",
        kind: "warn",
        user_id: "u1",
        moderator_id: "m1",
        reason: "spam",
        weight: 1,
        role_id: null,
        created_at: created,
        expires_at: null,
        ended_at: null,
        end_reason: null,
        ended_by: null,
        end_note: null,
        triggered_by: null,
        threshold_level: null,
        dm_delivered: null,
        dm_error: null,
        ...overrides,
    };
}

const ctx = { guildId: "g1", guildName: "Sora", appealLine: null };
const description = (payload: ReturnType<typeof dmPayload>) =>
    (payload.embeds?.[0] as { toJSON(): { description: string } }).toJSON().description;

test("a warn DM has the exact lines, no Weight line and a full + relative expiry", () => {
    const expires = new Date((T + 86400) * 1000);
    const payload = dmPayload({ type: "punished", case: row({ weight: 3, expires_at: expires }) }, ctx);
    expect(description(payload)).toBe(
        `**You got warned - Case \`K7XQ2MP\`**\n> **Reason:** spam\n> **Expires:** <t:${T + 86400}:F> (<t:${T + 86400}:R>)`,
    );
    expect(description(payload)).not.toContain("Weight");
});

test("a permanent ban DM says Permanent and a temp ban shows the duration", () => {
    expect(description(dmPayload({ type: "punished", case: row({ kind: "ban" }) }, ctx))).toBe(
        "**You got banned - Case `K7XQ2MP`**\n> **Reason:** spam\n> **Duration:** Permanent",
    );
    const temp = row({ kind: "ban", expires_at: new Date((T + 7 * 86400) * 1000) });
    expect(description(dmPayload({ type: "punished", case: temp }, ctx))).toContain("> **Duration:** 7d");
});

test("a mute DM has Duration and Ends", () => {
    const text = description(dmPayload({ type: "punished", case: row({ kind: "mute", expires_at: new Date((T + 3600) * 1000) }) }, ctx));
    expect(text).toContain("**You got muted - Case `K7XQ2MP`**");
    expect(text).toContain("> **Duration:** 1h");
    expect(text).toContain(`> **Ends:** <t:${T + 3600}:F> (<t:${T + 3600}:R>)`);
});

test("an unban DM for an expired temp ban says Expired", () => {
    const text = description(dmPayload({ type: "ended", case: row({ kind: "ban" }), reason: "Expired" }, ctx));
    expect(text).toBe("**You got unbanned - Case `K7XQ2MP`**\n> **Reason:** Expired");
});

test("titles cover kick, softban, unwarn and unmute", () => {
    expect(description(dmPayload({ type: "punished", case: row({ kind: "kick" }) }, ctx))).toContain("You got kicked");
    expect(description(dmPayload({ type: "punished", case: row({ kind: "softban" }) }, ctx))).toContain("You got softbanned");
    expect(description(dmPayload({ type: "ended", case: row({}), reason: "Expired" }, ctx))).toContain("You got unwarned");
    expect(description(dmPayload({ type: "ended", case: row({ kind: "mute" }), reason: "ok" }, ctx))).toContain("You got unmuted");
});

test("the appeal line shows on punishments only, when set", () => {
    const withAppeal = { ...ctx, appealLine: "Appeal at example.com" };
    expect(description(dmPayload({ type: "punished", case: row({ kind: "kick" }) }, withAppeal))).toEndWith("\n\n> Appeal at example.com");
    expect(description(dmPayload({ type: "punished", case: row({ kind: "kick" }) }, ctx))).not.toContain("Appeal");
    expect(description(dmPayload({ type: "ended", case: row({}), reason: "Expired" }, withAppeal))).not.toContain("Appeal");
});

test("the button is a link labelled From <server> (80 max) to the guild", () => {
    const payload = dmPayload({ type: "punished", case: row({}) }, { ...ctx, guildName: "x".repeat(100) });
    const button = (payload.components?.[0] as { toJSON(): { components: Array<{ label: string; url: string; style: number }> } }).toJSON()
        .components[0];
    expect(button?.label).toHaveLength(80);
    expect(button?.label.startsWith("From xxx")).toBe(true);
    expect(button?.url).toBe("https://discord.com/channels/g1");
    expect(button?.style).toBe(5);
});

test("DM colors: warn, punishment, ended", () => {
    const color = (p: ReturnType<typeof dmPayload>) => (p.embeds?.[0] as { toJSON(): { color: number } }).toJSON().color;
    expect(color(dmPayload({ type: "punished", case: row({}) }, ctx))).toBe(0xf0b232);
    expect(color(dmPayload({ type: "punished", case: row({ kind: "ban" }) }, ctx))).toBe(0xda373c);
    expect(color(dmPayload({ type: "ended", case: row({}), reason: "x" }, ctx))).toBe(0x23a55a);
});

type Json = { accent_color: number; components: Array<{ type: number; content?: string }> };
const channel = (e: Parameters<typeof caseChannelPayload>[0]) => {
    const payload = caseChannelPayload(e);
    const json = (payload.components?.[0] as { toJSON(): Json }).toJSON();
    return { payload, json, texts: json.components.filter((c) => c.type === 10).map((c) => c.content ?? "") };
};

test("the Case Channel post is a Components V2 container with NO_PINGS", () => {
    const { payload, json } = channel({ event: "created", case: row({}), by: "m1" });
    expect(payload.allowedMentions).toBe(NO_PINGS);
    expect(payload.flags).toBe(MessageFlags.IsComponentsV2);
    expect(payload.embeds).toBeUndefined();
    expect(json.components.filter((c) => c.type === 14)).toHaveLength(2);
});

test("a created warn has the header, event line, reason and details", () => {
    const { texts } = channel({ event: "created", case: row({ dm_delivered: false, dm_error: "DMs closed" }), by: "m1" });
    expect(texts[0]).toBe("**Warn** `K7XQ2MP`\n-# Created\n<@u1>, warned by <@m1>");
    expect(texts[1]).toBe("**Reason**\n>>> spam");
    expect(texts[2]).toBe(`- **Created:** <t:${T}:R>\n- **DM:** \`❌ Not delivered (DMs closed)\``);
});

test("an Auto-Punishment names Auto-Punishment and an unknown DM status is omitted", () => {
    const { texts } = channel({ event: "revoked", case: row({ moderator_id: null }), by: "m2" });
    expect(texts[0]).toContain("<@u1>, warned by Auto-Punishment");
    expect(texts[2]).not.toContain("DM:");
});

test("event lines: by the author, or bare when there is none", () => {
    const line = (event: Parameters<typeof caseChannelPayload>[0]["event"], by: string | null) =>
        channel({ event, case: row({}), by }).texts[0]?.split("\n")[1];
    expect(line("revoked", "m2")).toBe("-# Revoked by <@m2>");
    expect(line("reason_changed", "m2")).toBe("-# Reason changed by <@m2>");
    expect(line("auto_undone", "m2")).toBe("-# Auto-undone by <@m2>");
    expect(line("revoked", null)).toBe("-# Revoked");
    expect(line("expired", null)).toBe("-# Expired");
    expect(line("replaced", "m1")).toBe("-# Replaced");
});

test("a non-created event adds its own bullet and an optional note quote", () => {
    const at = new Date((T + 60) * 1000);
    const { texts } = channel({ event: "revoked", case: row({}), by: "m2", note: "mistake", at });
    expect(texts[2]).toBe(`- **Created:** <t:${T}:R>\n- **Revoked:** <t:${T + 60}:R>\n> **Reason:** mistake`);
    expect(channel({ event: "created", case: row({}), by: "m1", note: null }).texts[2]).not.toContain("> **Reason:**");
});

test("optional bullets: expiry, weight, role, trigger", () => {
    const expires = new Date((T + 86400) * 1000);
    const { texts } = channel({
        event: "created",
        case: row({ expires_at: expires, weight: 2, role_id: "r1", triggered_by: "spam" }),
        by: "m1",
    });
    expect(texts[2]).toBe(
        `- **Created:** <t:${T}:R>\n- **Expires:** <t:${T + 86400}:F> (<t:${T + 86400}:R>)\n- **Weight:** 2x\n- **Role:** <@&r1>\n- **Triggered by:** \`spam\``,
    );
});

test("Case Channel colors by event and kind", () => {
    const color = (event: Parameters<typeof caseChannelPayload>[0]["event"], kind: CaseRow["kind"]) =>
        channel({ event, case: row({ kind }), by: null }).json.accent_color;
    expect(color("created", "warn")).toBe(settings.warnColor);
    expect(color("reason_changed", "warn")).toBe(settings.warnColor);
    expect(color("created", "temprole")).toBe(settings.accentColor);
    expect(color("reason_changed", "temprole")).toBe(settings.accentColor);
    expect(color("created", "ban")).toBe(settings.punishColor);
    for (const e of ["revoked", "expired", "replaced", "auto_undone"] as const) expect(color(e, "ban")).toBe(settings.endColor);
});

test("dmPayload also pins NO_PINGS", () => {
    expect(dmPayload({ type: "punished", case: row({}) }, ctx).allowedMentions).toBe(NO_PINGS);
});
