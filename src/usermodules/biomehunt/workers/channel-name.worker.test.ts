import { describe, expect, test } from "bun:test";
import { type ChannelNameDeps, createChannelNameTick } from "./channel-name.worker";

const MIN = 60_000;
const NOW = 1_000_000_000;

type Candidate = Awaited<ReturnType<ChannelNameDeps["getCandidates"]>>[number];

const candidate = (n: number, over: Partial<Candidate> = {}): Candidate => ({
    userId: n,
    guildId: "g1",
    channelId: `c${n}`,
    nameBadges: "",
    renamedAt: null,
    flagOn: true,
    ...over,
});

function setup(
    candidates: Candidate[],
    opts: { missing?: string[]; denied?: string[]; failing?: string[]; canManage?: () => boolean; canManageChannel?: () => boolean } = {},
) {
    const clock = { now: NOW };
    const names = new Map(candidates.map((c) => [c.channelId, `${c.nameBadges}・u${c.userId}`]));
    const renames: Array<{ channelId: string; name: string }> = [];
    const stored: Array<{ userId: number; badges: string }> = [];
    const warned: string[] = [];
    const cleared: string[] = [];
    const deps: ChannelNameDeps = {
        now: () => clock.now,
        getCandidates: async () => candidates,
        getCounts: async (ids) => new Map(ids.map((id) => [id, [{ biome: "GLITCHED", count: 1 }]])),
        setNameBadges: async (userId, badges) => void stored.push({ userId, badges }),
        getChannel: (_g, channelId) =>
            opts.missing?.includes(channelId)
                ? null
                : {
                      name: names.get(channelId) ?? "",
                      setName: async (name) => {
                          if (opts.failing?.includes(channelId)) throw new Error("boom");
                          if (opts.denied?.includes(channelId)) throw Object.assign(new Error("Missing Permissions"), { code: 50013 });
                          renames.push({ channelId, name });
                      },
                  },
        canManageChannels: () => opts.canManage?.() ?? true,
        canManageChannel: () => opts.canManageChannel?.() ?? true,
        warn: async (guildId) => void warned.push(guildId),
        clearWarn: (guildId) => void cleared.push(guildId),
    };
    return { clock, tick: createChannelNameTick(deps), renames, stored, warned, cleared };
}

describe("channel name tick", () => {
    test("a channel whose rename fails waits the gap, and the others still get renamed", async () => {
        const { tick, renames, clock } = setup(
            [1, 2, 3, 4, 5, 6].map((n) => candidate(n)),
            { failing: ["c1"] },
        );
        await tick();
        expect(renames.map((r) => r.channelId)).toEqual(["c2", "c3", "c4", "c5"]);
        await tick();
        expect(renames.map((r) => r.channelId)).toContain("c6");
        expect(renames.filter((r) => r.channelId === "c1")).toHaveLength(0);
        clock.now += 5 * MIN;
        await tick();
        // c1 is tried again only after the gap (it fails again, so still no rename).
        expect(renames.filter((r) => r.channelId === "c1")).toHaveLength(0);
    });

    test("a channel-level 50013 skips that channel, keeps the log warning once and renames the rest", async () => {
        let channelOk = false;
        const denied = ["c1"];
        const { tick, renames, warned, cleared, clock } = setup([candidate(1), candidate(2)], {
            denied,
            canManageChannel: () => channelOk,
        });
        await tick();
        expect(warned).toEqual(["g1"]);
        expect(renames.map((r) => r.channelId)).toEqual(["c2"]);
        clock.now += 10 * MIN;
        await tick();
        await tick();
        expect(warned).toEqual(["g1"]);
        expect(renames.filter((r) => r.channelId === "c1")).toHaveLength(0);
        // The warning dedup is cleared only by a successful rename in the server.
        expect(cleared).toContain("g1");
        channelOk = true;
        denied.length = 0;
        clock.now += 10 * MIN;
        await tick();
        expect(renames.map((r) => r.channelId)).toContain("c1");
    });

    test("renames at most 5 per tick", async () => {
        const { tick, renames } = setup([1, 2, 3, 4, 5, 6, 7].map((n) => candidate(n)));
        await tick();
        expect(renames).toHaveLength(5);
    });

    test("stores the badges after a rename", async () => {
        const { tick, renames, stored } = setup([candidate(1)]);
        await tick();
        expect(renames).toEqual([{ channelId: "c1", name: "🔥1・u1" }]);
        expect(stored).toEqual([{ userId: 1, badges: "🔥1" }]);
    });

    test("waits 6 minutes between renames of one channel", async () => {
        const recent = candidate(1, { renamedAt: new Date(NOW - 5 * MIN) });
        const old = candidate(2, { renamedAt: new Date(NOW - 6 * MIN) });
        const { tick, renames } = setup([recent, old]);
        await tick();
        expect(renames.map((r) => r.channelId)).toEqual(["c2"]);
    });

    test("skips channels missing from cache", async () => {
        const { tick, renames } = setup([candidate(1), candidate(2)], { missing: ["c1"] });
        await tick();
        expect(renames.map((r) => r.channelId)).toEqual(["c2"]);
    });

    test("leaves a channel whose name is already right", async () => {
        const { tick, renames } = setup([candidate(1, { nameBadges: "🔥1" })]);
        await tick();
        expect(renames).toHaveLength(0);
    });

    test("flag off removes stored badges", async () => {
        const { tick, renames, stored } = setup([candidate(1, { flagOn: false, nameBadges: "🔥1" })]);
        await tick();
        expect(renames).toEqual([{ channelId: "c1", name: "・u1" }]);
        expect(stored).toEqual([{ userId: 1, badges: "" }]);
    });

    test("stops retrying a guild without Manage Channels", async () => {
        const { tick, renames, warned } = setup(
            [1, 2, 3].map((n) => candidate(n)),
            { denied: ["c1"], canManage: () => false },
        );
        await tick();
        expect(warned).toEqual(["g1"]);
        expect(renames).toHaveLength(0);
        await tick();
        expect(warned).toEqual(["g1"]);
        expect(renames).toHaveLength(0);
    });

    test("tries the guild again once the permission is back", async () => {
        let allowed = false;
        const denied = ["c1"];
        const { tick, renames, cleared } = setup([candidate(1), candidate(2)], { denied, canManage: () => allowed });
        await tick();
        allowed = true;
        denied.length = 0;
        await tick();
        expect(cleared).toContain("g1");
        expect(renames.map((r) => r.channelId)).toContain("c2");
    });
});
