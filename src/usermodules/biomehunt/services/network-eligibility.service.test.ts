import { expect, test } from "bun:test";
import type { BiomeDelayedForwardRow, BiomeForwardRow } from "../types";
import {
    buildServerCard,
    countActiveMembers,
    type EligibilityDeps,
    type EligibilityFacts,
    evaluateEligibility,
    isConfigGap,
    loadEligibility,
    NETWORK_BIOMES,
} from "./network-eligibility.service";

const HOUR = 3600;

function facts(overrides: Partial<EligibilityFacts> = {}): EligibilityFacts {
    return {
        forwardedBiomes: new Set(NETWORK_BIOMES),
        localForwardChannelIds: new Set(["local"]),
        networkChannelId: "net",
        staffChannelId: "staff",
        staffRoleId: "role",
        activeMembers: 3,
        ...overrides,
    };
}

test("NETWORK_BIOMES is the four rare biomes", () => {
    expect([...NETWORK_BIOMES].sort()).toEqual(["CYBERSPACE", "DREAMSPACE", "GLITCHED", "SINGULARITY"]);
});

test("evaluateEligibility: a fully set-up guild has no gaps", () => {
    expect(evaluateEligibility(facts())).toEqual([]);
});

test("evaluateEligibility: lists exactly the Network biomes with no local forward", () => {
    const gaps = evaluateEligibility(facts({ forwardedBiomes: new Set([NETWORK_BIOMES[0]]) }));
    expect(gaps).toEqual([{ kind: "forwards", missing: NETWORK_BIOMES.slice(1) }]);
});

test("evaluateEligibility: no Network channel is a gap", () => {
    expect(evaluateEligibility(facts({ networkChannelId: null }))).toEqual([{ kind: "network_channel" }]);
});

test("evaluateEligibility: a Network channel that is also a local forward channel is a conflict", () => {
    expect(evaluateEligibility(facts({ networkChannelId: "local" }))).toEqual([{ kind: "network_channel_conflict" }]);
});

test("evaluateEligibility: staff needs both a channel and a role", () => {
    expect(evaluateEligibility(facts({ staffRoleId: null }))).toEqual([{ kind: "staff" }]);
    expect(evaluateEligibility(facts({ staffChannelId: null }))).toEqual([{ kind: "staff" }]);
});

test("evaluateEligibility: fewer active members than the minimum reports the current count", () => {
    expect(evaluateEligibility(facts({ activeMembers: 2 }))).toEqual([{ kind: "activity", activeMembers: 2 }]);
});

test("isConfigGap: only channel/staff gaps are fixable by the config flow", () => {
    expect(isConfigGap({ kind: "network_channel" })).toBe(true);
    expect(isConfigGap({ kind: "network_channel_conflict" })).toBe(true);
    expect(isConfigGap({ kind: "staff" })).toBe(true);
    expect(isConfigGap({ kind: "forwards", missing: ["GLITCHED"] })).toBe(false);
    expect(isConfigGap({ kind: "activity", activeMembers: 0 })).toBe(false);
});

test("countActiveMembers: exactly 5h counts, one second less does not", () => {
    expect(countActiveMembers([{ activeSeconds: 5 * HOUR }, { activeSeconds: 5 * HOUR - 1 }, { activeSeconds: 0 }])).toBe(1);
});

test("buildServerCard: sums macro hours with one decimal", () => {
    const card = buildServerCard([{ activeSeconds: 5 * HOUR }, { activeSeconds: 1800 }], [{ activeSeconds: 40 * HOUR }]);
    expect(card).toEqual({ activeMembers: 1, macroHours7d: 5.5, macroHours30d: 40 });
});

function liveForward(biome: string, channel_id: string): BiomeForwardRow {
    return { guild_id: "g1", biome, channel_id, role_id: null };
}

test("loadEligibility: live and delayed forwards both count, and both kinds of channel are local", async () => {
    const [first, ...rest] = NETWORK_BIOMES;
    const delayed: BiomeDelayedForwardRow[] = rest.map((biome) => ({ ...liveForward(biome, "delayed-ch"), delay_s: 10 }));
    const deps: EligibilityDeps = {
        getNetworkGuild: async () => null,
        getForwardConfigs: async () => [liveForward(first, "live-ch")],
        getDelayedForwardConfigs: async () => delayed,
        getGuildActiveSecondsBetween: async () => [],
    };
    const report = await loadEligibility("g1", new Date("2026-10-01T00:00:00Z"), deps);
    expect(report.facts.forwardedBiomes).toEqual(new Set(NETWORK_BIOMES));
    expect(report.facts.localForwardChannelIds).toEqual(new Set(["live-ch", "delayed-ch"]));
    expect(report.gaps.map((g) => g.kind)).toEqual(["network_channel", "staff", "activity"]);
});

test("loadEligibility: asks for the 7-day and 30-day windows ending at now", async () => {
    const now = new Date("2026-10-01T00:00:00Z");
    const starts: number[] = [];
    const deps: EligibilityDeps = {
        getNetworkGuild: async () => null,
        getForwardConfigs: async () => [],
        getDelayedForwardConfigs: async () => [],
        getGuildActiveSecondsBetween: async (_g, start, end) => {
            starts.push((end.getTime() - start.getTime()) / 86_400_000);
            return [];
        },
    };
    await loadEligibility("g1", now, deps);
    expect(starts.sort((a, b) => a - b)).toEqual([7, 30]);
});
