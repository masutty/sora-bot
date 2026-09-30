import { expect, test } from "bun:test";
import type { BiomeForwardRow, UserRow } from "../types";
import { BiomeHuntError } from "../types";
import { resolveSimulateBiomeTarget, type SimulateBiomeDeps } from "./bh-owner.command";

function fakeUser(overrides: Partial<UserRow> = {}): UserRow {
    return {
        id: 7,
        guild_id: "g1",
        discord_user_id: "target-1",
        current_status: "active",
        last_activity_at: null,
        paused_at: null,
        created_at: new Date(),
        seeds: 0,
        xp: 0,
        flower: null,
        ...overrides,
    };
}

function fakeForward(overrides: Partial<BiomeForwardRow> = {}): BiomeForwardRow {
    return { guild_id: "g1", biome: "GLITCHED", channel_id: "forward-channel", role_id: null, ...overrides };
}

/** An in-memory `SimulateBiomeDeps` - never touches the DB. */
function createFakeDeps(user: UserRow | null, forward: BiomeForwardRow | null): SimulateBiomeDeps {
    return {
        getUserByDiscordId: async () => user,
        getForwardConfig: async () => forward,
    };
}

test("resolveSimulateBiomeTarget rejects an unknown biome before touching any dep", async () => {
    let called = false;
    const deps: SimulateBiomeDeps = {
        getUserByDiscordId: async () => {
            called = true;
            return fakeUser();
        },
        getForwardConfig: async () => {
            called = true;
            return fakeForward();
        },
    };

    await expect(resolveSimulateBiomeTarget("g1", "target-1", "NOT_A_BIOME", deps)).rejects.toThrow(BiomeHuntError);
    await expect(resolveSimulateBiomeTarget("g1", "target-1", "NOT_A_BIOME", deps)).rejects.toThrow(/not a known biome/);
    expect(called).toBe(false);
});

test("resolveSimulateBiomeTarget rejects a target with no profile in this guild", async () => {
    const deps = createFakeDeps(null, fakeForward());

    await expect(resolveSimulateBiomeTarget("g1", "target-1", "GLITCHED", deps)).rejects.toThrow(BiomeHuntError);
    await expect(resolveSimulateBiomeTarget("g1", "target-1", "GLITCHED", deps)).rejects.toThrow(/has no profile in this server/);
});

test("resolveSimulateBiomeTarget rejects a biome with no forward configured", async () => {
    const deps = createFakeDeps(fakeUser(), null);

    await expect(resolveSimulateBiomeTarget("g1", "target-1", "GLITCHED", deps)).rejects.toThrow(BiomeHuntError);
    await expect(resolveSimulateBiomeTarget("g1", "target-1", "GLITCHED", deps)).rejects.toThrow(/No forward is configured/);
});

test("resolveSimulateBiomeTarget resolves the user id and forward channel when everything checks out", async () => {
    const deps = createFakeDeps(fakeUser({ id: 99 }), fakeForward({ channel_id: "chan-99" }));

    const result = await resolveSimulateBiomeTarget("g1", "target-1", "GLITCHED", deps);

    expect(result).toEqual({ userId: 99, forwardChannelId: "chan-99" });
});

test("resolveSimulateBiomeTarget accepts a non-rare biome too", async () => {
    const deps = createFakeDeps(fakeUser(), fakeForward({ biome: "WINDY" }));
    expect(await resolveSimulateBiomeTarget("g1", "target-1", "WINDY", deps)).toEqual({ userId: 7, forwardChannelId: "forward-channel" });
});
