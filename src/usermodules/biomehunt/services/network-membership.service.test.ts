import { expect, test } from "bun:test";
import type { Client, ContainerBuilder, MessageCreateOptions } from "discord.js";
import { BiomeHuntError, type NetworkBanKind, type NetworkGuildRow, NetworkStatus } from "../types";
import type { EligibilityFacts, EligibilityGap } from "./network-eligibility.service";
import {
    banFromNetwork,
    decideJoinRequest,
    forceIntoNetwork,
    leaveNetwork,
    type MembershipDeps,
    notifyStaff,
    precheckJoin,
    requireSnowflake,
    submitJoinRequest,
} from "./network-membership.service";

function fakeRow(overrides: Partial<NetworkGuildRow> = {}): NetworkGuildRow {
    return {
        guild_id: "g1",
        status: NetworkStatus.NONE,
        forced: false,
        network_channel_id: null,
        staff_channel_id: "staff",
        staff_role_id: "role",
        announce_role_id: null,
        invite_url: null,
        requested_at: null,
        approved_at: null,
        decided_by: null,
        low_activity_checks: 0,
        last_activity_check: null,
        created_at: new Date(),
        updated_at: new Date(),
        ...overrides,
    };
}

interface FakeOptions {
    rows?: NetworkGuildRow[];
    gaps?: EligibilityGap[];
    banned?: Array<[NetworkBanKind, string]>;
    hasGuild?: boolean;
}

/** An in-memory `MembershipDeps`. `transitionNetworkStatus` keeps the repository's compare-and-set contract. */
function createFakeDeps(opts: FakeOptions = {}) {
    const rows = new Map((opts.rows ?? []).map((r) => [r.guild_id, r]));
    const bans = new Set((opts.banned ?? []).map(([k, id]) => `${k}:${id}`));
    const exclusions = new Set<string>();
    const calls = {
        ownerDms: [] as MessageCreateOptions[],
        staff: [] as Array<{ guildId: string; content: string }>,
        welcomes: [] as Array<{ guildId: string; inviteUrl: string | null }>,
    };
    const deps: MembershipDeps = {
        getOrCreateGuildConfig: async () => undefined,
        ensureNetworkGuild: async (guildId) => {
            const row = rows.get(guildId) ?? fakeRow({ guild_id: guildId });
            rows.set(guildId, row);
            return row;
        },
        getNetworkGuild: async (guildId) => rows.get(guildId) ?? null,
        transitionNetworkStatus: async (guildId, from, to, fields = {}) => {
            const row = rows.get(guildId);
            if (!row || !from.includes(row.status)) return null;
            const next = { ...row, status: to, forced: fields.forced ?? row.forced, decided_by: fields.decidedBy ?? row.decided_by };
            rows.set(guildId, next);
            return next;
        },
        updateNetworkConfig: async (guildId, patch) => {
            const row = rows.get(guildId);
            if (!row) return;
            rows.set(guildId, {
                ...row,
                network_channel_id: patch.networkChannelId !== undefined ? patch.networkChannelId : row.network_channel_id,
            });
        },
        isNetworkBanned: async (kind, id) => bans.has(`${kind}:${id}`),
        addNetworkBan: async (kind, id) => {
            const key = `${kind}:${id}`;
            if (bans.has(key)) return false;
            bans.add(key);
            return true;
        },
        removeNetworkBan: async (kind, id) => bans.delete(`${kind}:${id}`),
        addNetworkExclusion: async (guildId, userId) => {
            const key = `${guildId}:${userId}`;
            if (exclusions.has(key)) return false;
            exclusions.add(key);
            return true;
        },
        removeNetworkExclusion: async (guildId, userId) => exclusions.delete(`${guildId}:${userId}`),
        loadEligibility: async () => ({
            facts: {} as EligibilityFacts,
            gaps: opts.gaps ?? [],
            card: { activeMembers: 3, macroHours7d: 20, macroHours30d: 80 },
        }),
        guildName: (guildId) => `Guild ${guildId}`,
        hasGuild: () => opts.hasGuild ?? true,
        notifyOwners: async (payload) => {
            calls.ownerDms.push(payload);
        },
        notifyStaff: async (row, content) => {
            calls.staff.push({ guildId: row.guild_id, content });
        },
        welcomeNewMember: async (row) => {
            calls.welcomes.push({ guildId: row.guild_id, inviteUrl: row.invite_url });
        },
    };
    return { deps, rows, calls };
}

test("precheckJoin refuses a banned guild", async () => {
    const { deps } = createFakeDeps({ banned: [["guild", "g1"]] });
    await expect(precheckJoin("g1", deps)).rejects.toBeInstanceOf(BiomeHuntError);
});

test("precheckJoin refuses a guild already in the Network or waiting", async () => {
    for (const status of [NetworkStatus.MEMBER, NetworkStatus.PENDING]) {
        const { deps } = createFakeDeps({ rows: [fakeRow({ status })] });
        await expect(precheckJoin("g1", deps)).rejects.toBeInstanceOf(BiomeHuntError);
    }
});

test("precheckJoin returns only the gaps the config flow cannot fix", async () => {
    const { deps } = createFakeDeps({ gaps: [{ kind: "staff" }, { kind: "activity", activeMembers: 1 }, { kind: "network_channel" }] });
    expect(await precheckJoin("g1", deps)).toEqual([{ kind: "activity", activeMembers: 1 }]);
});

test("submitJoinRequest: an ineligible guild stays out and no owner is bothered", async () => {
    const { deps, rows, calls } = createFakeDeps({ rows: [fakeRow()], gaps: [{ kind: "staff" }] });
    expect(await submitJoinRequest("g1", deps)).toEqual({ kind: "ineligible", gaps: [{ kind: "staff" }] });
    expect(rows.get("g1")?.status).toBe(NetworkStatus.NONE);
    expect(calls.ownerDms).toHaveLength(0);
});

test("submitJoinRequest: an eligible guild goes pending and the owners get one request with Approve/Reject", async () => {
    const { deps, rows, calls } = createFakeDeps({ rows: [fakeRow()] });
    expect(await submitJoinRequest("g1", deps)).toEqual({ kind: "submitted" });
    expect(rows.get("g1")?.status).toBe(NetworkStatus.PENDING);
    expect(calls.ownerDms).toHaveLength(1);
    const dm = JSON.stringify((calls.ownerDms[0].components as ContainerBuilder[]).map((c) => c.toJSON()));
    expect(dm).toContain("biomehunt:network-review:g1:approve");
});

test("submitJoinRequest twice sends one request", async () => {
    const { deps, calls } = createFakeDeps({ rows: [fakeRow()] });
    await submitJoinRequest("g1", deps);
    expect(await submitJoinRequest("g1", deps)).toEqual({ kind: "not_available" });
    expect(calls.ownerDms).toHaveLength(1);
});

test("decideJoinRequest: approve makes it a member and tells its staff; a second decision is not_pending", async () => {
    const { deps, rows, calls } = createFakeDeps({ rows: [fakeRow({ status: NetworkStatus.PENDING })] });
    expect(await decideJoinRequest("g1", "o1", true, deps)).toBe("ok");
    expect(rows.get("g1")?.status).toBe(NetworkStatus.MEMBER);
    expect(rows.get("g1")?.decided_by).toBe("o1");
    expect(await decideJoinRequest("g1", "o2", false, deps)).toBe("not_pending");
    expect(rows.get("g1")?.status).toBe(NetworkStatus.MEMBER);
    expect(calls.staff).toHaveLength(1);
});

test("decideJoinRequest: reject puts it back to none", async () => {
    const { deps, rows } = createFakeDeps({ rows: [fakeRow({ status: NetworkStatus.PENDING })] });
    expect(await decideJoinRequest("g1", "o1", false, deps)).toBe("ok");
    expect(rows.get("g1")?.status).toBe(NetworkStatus.NONE);
});

test("leaveNetwork: a forced member leaves and loses the forced flag; leaving again is false", async () => {
    const { deps, rows } = createFakeDeps({ rows: [fakeRow({ status: NetworkStatus.MEMBER, forced: true })] });
    expect(await leaveNetwork("g1", deps)).toBe(true);
    expect(rows.get("g1")?.status).toBe(NetworkStatus.NONE);
    expect(rows.get("g1")?.forced).toBe(false);
    expect(await leaveNetwork("g1", deps)).toBe(false);
});

test("forceIntoNetwork: sets the Network channel and makes it a forced member", async () => {
    const { deps, rows } = createFakeDeps();
    await forceIntoNetwork("g1", "net", "o1", deps);
    expect(rows.get("g1")).toMatchObject({ status: NetworkStatus.MEMBER, forced: true, network_channel_id: "net", decided_by: "o1" });
});

test("forceIntoNetwork refuses a banned guild and a guild the bot is not in", async () => {
    await expect(forceIntoNetwork("g1", "net", "o1", createFakeDeps({ banned: [["guild", "g1"]] }).deps)).rejects.toBeInstanceOf(
        BiomeHuntError,
    );
    await expect(forceIntoNetwork("g1", "net", "o1", createFakeDeps({ hasGuild: false }).deps)).rejects.toBeInstanceOf(BiomeHuntError);
});

test("banFromNetwork: a banned guild also loses its membership; banning again returns false", async () => {
    const { deps, rows } = createFakeDeps({ rows: [fakeRow({ status: NetworkStatus.MEMBER })] });
    expect(await banFromNetwork("guild", "g1", "o1", null, deps)).toBe(true);
    expect(rows.get("g1")?.status).toBe(NetworkStatus.NONE);
    expect(await banFromNetwork("guild", "g1", "o1", null, deps)).toBe(false);
});

test("notifyStaff: a missing staff channel never throws", async () => {
    const client = {
        channels: {
            fetch: async () => {
                throw new Error("Unknown Channel");
            },
        },
    } as unknown as Client;
    await expect(notifyStaff(client, fakeRow(), "hello")).resolves.toBeUndefined();
});

test("notifyStaff: pings only the staff role", async () => {
    const sent: unknown[] = [];
    const channel = { isDMBased: () => false, isTextBased: () => true, send: async (p: unknown) => sent.push(p) };
    const client = { channels: { fetch: async () => channel } } as unknown as Client;
    await notifyStaff(client, fakeRow(), "hello");
    expect(sent).toEqual([{ content: "<@&role> hello", allowedMentions: { parse: [], roles: ["role"] } }]);
});

test("decideJoinRequest: approving a guild banned while its request was pending rejects it instead", async () => {
    const { deps, rows } = createFakeDeps({ rows: [fakeRow({ status: NetworkStatus.PENDING })], banned: [["guild", "g1"]] });
    expect(await decideJoinRequest("g1", "o1", true, deps)).toBe("banned");
    expect(rows.get("g1")?.status).toBe(NetworkStatus.NONE);
});

test("requireSnowflake accepts Discord ids only", () => {
    expect(() => requireSnowflake("not-an-id")).toThrow(BiomeHuntError);
    expect(() => requireSnowflake("123")).toThrow(BiomeHuntError);
    expect(requireSnowflake(" 188851299255713792 ")).toBe("188851299255713792");
});

test("decideJoinRequest: only an approval that actually admits the server welcomes it to the Network", async () => {
    const approved = createFakeDeps({ rows: [fakeRow({ status: NetworkStatus.PENDING, invite_url: "https://discord.gg/g1" })] });
    await decideJoinRequest("g1", "o1", true, approved.deps);
    await decideJoinRequest("g1", "o1", true, approved.deps);
    expect(approved.calls.welcomes).toEqual([{ guildId: "g1", inviteUrl: "https://discord.gg/g1" }]);

    const rejected = createFakeDeps({ rows: [fakeRow({ status: NetworkStatus.PENDING })] });
    await decideJoinRequest("g1", "o1", false, rejected.deps);
    expect(rejected.calls.welcomes).toHaveLength(0);

    const banned = createFakeDeps({ rows: [fakeRow({ status: NetworkStatus.PENDING })], banned: [["guild", "g1"]] });
    await decideJoinRequest("g1", "o1", true, banned.deps);
    expect(banned.calls.welcomes).toHaveLength(0);
});

test("forceIntoNetwork never announces the server to the Network", async () => {
    const { deps, calls } = createFakeDeps({ rows: [fakeRow({ status: NetworkStatus.PENDING })] });
    await forceIntoNetwork("g1", "net", "o1", deps);
    expect(calls.welcomes).toHaveLength(0);
});
