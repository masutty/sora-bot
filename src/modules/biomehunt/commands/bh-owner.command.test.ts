import { expect, test } from "bun:test";
import type { BiomeForwardRow, UserRow } from "../types";
import { BiomeHuntError } from "../types";
import { resolveSimulateRareTarget, type SimulateRareDeps } from "./bh-owner.command";

function fakeUser(overrides: Partial<UserRow> = {}): UserRow {
    return {
        id: 7, guild_id: "g1", discord_user_id: "target-1", current_status: "active", last_activity_at: null,
        paused_at: null, created_at: new Date(), seeds: 0, xp: 0, flower: null, ...overrides,
    };
}

function fakeForward(overrides: Partial<BiomeForwardRow> = {}): BiomeForwardRow {
    return { guild_id: "g1", biome: "GLITCHED", channel_id: "forward-channel", role_id: null, ...overrides };
}

/** An in-memory `SimulateRareDeps` - never touches the DB. */
function createFakeDeps(user: UserRow | null, forward: BiomeForwardRow | null): SimulateRareDeps {
    return {
        getUserByDiscordId: async () => user,
        getForwardConfig: async () => forward,
    };
}

test("resolveSimulateRareTarget rejects a non-rare biome before touching any dep", async () => {
    let called = false;
    const deps: SimulateRareDeps = {
        getUserByDiscordId: async () => { called = true; return fakeUser(); },
        getForwardConfig: async () => { called = true; return fakeForward(); },
    };

    await expect(resolveSimulateRareTarget("g1", "target-1", "WINDY", deps)).rejects.toThrow(BiomeHuntError);
    await expect(resolveSimulateRareTarget("g1", "target-1", "WINDY", deps)).rejects.toThrow(/not a rare biome/);
    expect(called).toBe(false);
});

test("resolveSimulateRareTarget rejects a target with no profile in this guild", async () => {
    const deps = createFakeDeps(null, fakeForward());

    await expect(resolveSimulateRareTarget("g1", "target-1", "GLITCHED", deps)).rejects.toThrow(BiomeHuntError);
    await expect(resolveSimulateRareTarget("g1", "target-1", "GLITCHED", deps)).rejects.toThrow(/has no profile in this server/);
});

test("resolveSimulateRareTarget rejects a rare biome with no forward configured", async () => {
    const deps = createFakeDeps(fakeUser(), null);

    await expect(resolveSimulateRareTarget("g1", "target-1", "GLITCHED", deps)).rejects.toThrow(BiomeHuntError);
    await expect(resolveSimulateRareTarget("g1", "target-1", "GLITCHED", deps)).rejects.toThrow(/No forward is configured/);
});

test("resolveSimulateRareTarget resolves the user id and forward channel when everything checks out", async () => {
    const deps = createFakeDeps(fakeUser({ id: 99 }), fakeForward({ channel_id: "chan-99" }));

    const result = await resolveSimulateRareTarget("g1", "target-1", "GLITCHED", deps);

    expect(result).toEqual({ userId: 99, forwardChannelId: "chan-99" });
});
