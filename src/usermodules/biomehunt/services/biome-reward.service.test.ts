import { afterEach, expect, test } from "bun:test";
import { getAwardableBadges, getBadgeMeta, getRoleBadges, INFINITY_BADGE, resolveBadgeSlug } from "../constants/badges.constants";
import { getAllBiomes, resetBiomeRegistry, setBiomeRegistry } from "../constants/biomes.constants";
import { grantInfinityBadgeIfComplete, type InfinityBadgeDeps } from "./biome-reward.service";

afterEach(() => resetBiomeRegistry());

const RARES = ["GLITCHED", "CYBERSPACE", "DREAMSPACE", "SINGULARITY"];

function deps(found: string[], opts: { alreadyHas?: boolean; roleId?: string | null } = {}) {
    const granted: string[] = [];
    const jobs: unknown[][] = [];
    const d: InfinityBadgeDeps = {
        getFoundBiomes: async (_userId, biomes) => new Set(found.filter((b) => biomes.includes(b))),
        grantUserBadge: async (_userId, badge) => {
            if (opts.alreadyHas) return false;
            granted.push(badge);
            return true;
        },
        getGuildBadgeRole: async () => opts.roleId ?? null,
        enqueueRoleJob: async (...args) => void jobs.push(args),
    };
    return { d, granted, jobs };
}

test("every rare biome found: the Infinity Gauntlet is granted, with the guild's role for it", async () => {
    const { d, granted, jobs } = deps(RARES, { roleId: "r1" });

    expect(await grantInfinityBadgeIfComplete("g1", 7, d)).toBe(true);

    expect(granted).toEqual([INFINITY_BADGE]);
    expect(jobs).toEqual([["g1", 7, "r1", "add"]]);
});

test("one rare biome missing: no Infinity Gauntlet", async () => {
    const { d, granted } = deps(RARES.slice(0, 3));

    expect(await grantInfinityBadgeIfComplete("g1", 7, d)).toBe(false);
    expect(granted).toEqual([]);
});

test("a disabled rare biome isn't needed", async () => {
    setBiomeRegistry(getAllBiomes().map((b) => (b.key === "SINGULARITY" ? { ...b, enabled: false } : b)));
    const { d, granted } = deps(RARES.slice(0, 3));

    expect(await grantInfinityBadgeIfComplete("g1", 7, d)).toBe(true);
    expect(granted).toEqual([INFINITY_BADGE]);
});

test("already has it: no second role job", async () => {
    const { d, jobs } = deps(RARES, { alreadyHas: true, roleId: "r1" });

    expect(await grantInfinityBadgeIfComplete("g1", 7, d)).toBe(false);
    expect(jobs).toEqual([]);
});

test("the Infinity Gauntlet can get a role, be awarded by hand, and resolves from its slug", () => {
    expect(getRoleBadges()).toContain(INFINITY_BADGE);
    expect(getAwardableBadges()).toContain(INFINITY_BADGE);
    expect(resolveBadgeSlug(getBadgeMeta(INFINITY_BADGE).slug)).toBe(INFINITY_BADGE);
});
