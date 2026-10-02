import { expect, test } from "bun:test";
import type { MessageCreateOptions } from "discord.js";
import type { InsertNetworkAlertParams } from "../repository/network-posts.repository";
import { type NetworkAlertRow, type NetworkGuildRow, NetworkStatus } from "../types";
import { type DigestState, type NetworkDailyDeps, runActivityChecks, sendMultiMacroDigest, utcDay } from "./network-daily.service";
import type { EligibilityFacts } from "./network-eligibility.service";

const NOON = new Date("2026-10-02T12:30:00Z");

function guildRow(guildId: string, overrides: Partial<NetworkGuildRow> = {}): NetworkGuildRow {
    return {
        guild_id: guildId,
        status: NetworkStatus.MEMBER,
        forced: false,
        network_channel_id: "net",
        staff_channel_id: "staff",
        staff_role_id: "role",
        announce_role_id: null,
        invite_url: null,
        requested_at: null,
        approved_at: null,
        decided_by: null,
        low_activity_checks: 0,
        last_activity_check: null,
        created_at: NOON,
        updated_at: NOON,
        ...overrides,
    };
}

function alert(id: number, details: string): NetworkAlertRow {
    return { id, kind: "multi_macro", guild_id: "g", discord_user_id: "u", post_id: null, details, notified: false, created_at: NOON };
}

function createFakeDeps(guilds: NetworkGuildRow[], activeMembers: Record<string, number>, alerts: NetworkAlertRow[] = []) {
    const rows = new Map(guilds.map((g) => [g.guild_id, g]));
    const calls = {
        checks: [] as Array<{ guildId: string; day: string; low: number }>,
        alerts: [] as InsertNetworkAlertParams[],
        ownerDms: [] as MessageCreateOptions[],
        notified: [] as number[][],
    };
    const deps: NetworkDailyDeps = {
        getMemberNetworkGuilds: async () => [...rows.values()],
        loadEligibility: async (guildId) => ({
            facts: { activeMembers: activeMembers[guildId] ?? 0 } as EligibilityFacts,
            gaps: [],
            card: { activeMembers: activeMembers[guildId] ?? 0, macroHours7d: 0, macroHours30d: 0 },
        }),
        recordActivityCheck: async (guildId, day, low) => {
            calls.checks.push({ guildId, day, low });
            const row = rows.get(guildId);
            if (row) rows.set(guildId, { ...row, low_activity_checks: low, last_activity_check: localDate(day) });
        },
        insertNetworkAlert: async (a) => {
            calls.alerts.push(a);
        },
        notifyOwners: async (p) => {
            calls.ownerDms.push(p);
        },
        getUnnotifiedNetworkAlerts: async () => alerts.filter((a) => !calls.notified.flat().includes(a.id)),
        markNetworkAlertsNotified: async (ids) => {
            calls.notified.push(ids);
        },
        guildName: (id) => `Guild ${id}`,
    };
    return { deps, calls, rows };
}

/** node-pg parses a DATE column as local midnight - the fake does the same. */
function localDate(day: string): Date {
    const [y, m, d] = day.split("-").map(Number);
    return new Date(y, m - 1, d);
}

test("utcDay formats a date as its UTC calendar day", () => {
    expect(utcDay(new Date("2026-10-02T23:59:00Z"))).toBe("2026-10-02");
});

test("runActivityChecks: two daily checks in a row below the minimum alert the owner once", async () => {
    const { deps, calls } = createFakeDeps([guildRow("g1")], { g1: 2 });
    await runActivityChecks(NOON, deps);
    expect(calls.ownerDms).toHaveLength(0);

    await runActivityChecks(new Date("2026-10-03T12:30:00Z"), deps);
    expect(calls.ownerDms).toHaveLength(1);
    expect(calls.alerts[0]).toMatchObject({ kind: "low_activity", guildId: "g1" });

    await runActivityChecks(new Date("2026-10-04T12:30:00Z"), deps);
    expect(calls.ownerDms).toHaveLength(1);
});

test("runActivityChecks: runs once per UTC day, skips forced members, and a good day resets the streak", async () => {
    const { deps, calls, rows } = createFakeDeps([guildRow("g1", { low_activity_checks: 1 }), guildRow("g2", { forced: true })], { g1: 5 });
    await runActivityChecks(NOON, deps);
    await runActivityChecks(new Date("2026-10-02T18:00:00Z"), deps);
    expect(calls.checks).toEqual([{ guildId: "g1", day: "2026-10-02", low: 0 }]);
    expect(rows.get("g1")?.low_activity_checks).toBe(0);
});

test("sendMultiMacroDigest: once a day at the digest hour, one DM with every pending alert, then marked notified", async () => {
    const { deps, calls } = createFakeDeps([], {}, [alert(1, "first case"), alert(2, "second case")]);
    const state: DigestState = { lastDigestDay: null };

    await sendMultiMacroDigest(new Date("2026-10-02T09:00:00Z"), state, deps);
    expect(calls.ownerDms).toHaveLength(0);

    await sendMultiMacroDigest(NOON, state, deps);
    expect(calls.ownerDms).toHaveLength(1);
    expect(String(calls.ownerDms[0].content)).toContain("first case");
    expect(String(calls.ownerDms[0].content)).toContain("second case");
    expect(calls.notified).toEqual([[1, 2]]);

    await sendMultiMacroDigest(new Date("2026-10-02T13:30:00Z"), state, deps);
    expect(calls.ownerDms).toHaveLength(1);
});

test("sendMultiMacroDigest: nothing pending sends nothing", async () => {
    const { deps, calls } = createFakeDeps([], {}, []);
    await sendMultiMacroDigest(NOON, { lastDigestDay: null }, deps);
    expect(calls.ownerDms).toHaveLength(0);
});

test("runActivityChecks: the low-activity DM links the server's name to its invite", async () => {
    const { deps, calls } = createFakeDeps([guildRow("g1", { low_activity_checks: 1, invite_url: "https://discord.gg/g1" })], { g1: 0 });
    await runActivityChecks(NOON, deps);
    expect(String(calls.ownerDms[0].content)).toContain("[Guild g1](https://discord.gg/g1)");
});
