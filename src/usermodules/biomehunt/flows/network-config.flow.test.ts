import { expect, test } from "bun:test";
import { createFakeViewTransport, type ViewPayload } from "@/define";
import { EmbedFormatter } from "@/utils/format";
import type { NetworkConfigPatch } from "../repository/network.repository";
import { NETWORK_BIOMES } from "../services/network-eligibility.service";
import { isValidInvite, type NetworkConfigDeps, networkConfigFlow } from "./network-config.flow";

const OWNER = "owner";

type Json = { custom_id?: string; content?: string; components?: Json[]; accessory?: Json };

/** Same local test glue as `ez-setup.flow.test.ts`. */
function flatten(payload: ViewPayload): Json[] {
    const out: Json[] = [];
    const walk = (node: unknown) => {
        if (node === null || typeof node !== "object") return;
        const json = typeof (node as { toJSON?: unknown }).toJSON === "function" ? (node as { toJSON(): unknown }).toJSON() : node;
        if (Array.isArray(json)) {
            for (const child of json) walk(child);
            return;
        }
        const obj = json as Json;
        out.push(obj);
        walk(obj.components);
        walk(obj.accessory);
    };
    walk(payload.components);
    return out;
}

function text(payload: ViewPayload): string {
    return [payload.content ?? "", ...flatten(payload).map((c) => c.content ?? "")].filter(Boolean).join("\n");
}

function fakeDeps() {
    const updates: NetworkConfigPatch[] = [];
    const pings: Array<{ biome: string; roleId: string | null }> = [];
    const deps: NetworkConfigDeps = {
        getNetworkGuild: async () => null,
        getNetworkPings: async () => [],
        getLocalForwardChannelIds: async () => new Set(["c-local"]),
        updateNetworkConfig: async (_guildId, patch) => {
            updates.push(patch);
        },
        setNetworkPing: async (_guildId, biome, roleId) => {
            pings.push({ biome, roleId });
        },
    };
    return { deps, updates, pings };
}

test("isValidInvite accepts discord.gg and discord.com/invite links only", () => {
    expect(isValidInvite("https://discord.gg/solhunters")).toBe(true);
    expect(isValidInvite("https://discord.com/invite/sol-hunters")).toBe(true);
    expect(isValidInvite("discord.gg/solhunters")).toBe(false);
    expect(isValidInvite("https://evil.example/discord.gg/x")).toBe(false);
});

test("biomehunt.net-config: refuses a local forward channel, then walks every step and finishes", async () => {
    const { deps, updates, pings } = fakeDeps();
    const fake = createFakeViewTransport();
    const resultP = fake.run(
        networkConfigFlow(deps, "g1", async () => EmbedFormatter.success("saved")),
        undefined,
        OWNER,
    );
    await fake.flush();
    expect(text(fake.lastPayload())).toContain("Network Channel");

    await fake.emit(fake.click("channel", OWNER, ["c-local"]));
    expect(fake.notifies).toHaveLength(1);
    expect(updates).toHaveLength(0);
    expect(text(fake.lastPayload())).toContain("Network Channel");

    await fake.emit(fake.click("channel", OWNER, ["c-net"]));
    expect(updates).toEqual([{ networkChannelId: "c-net" }]);
    expect(text(fake.lastPayload())).toContain("Staff");

    await fake.emit(fake.click("staffChannel", OWNER, ["c-staff"]));
    expect(text(fake.lastPayload())).toContain("Staff");
    await fake.emit(fake.click("staffRole", OWNER, ["r-staff"]));
    expect(updates).toContainEqual({ staffChannelId: "c-staff" });
    expect(updates).toContainEqual({ staffRoleId: "r-staff" });
    expect(text(fake.lastPayload())).toContain("Pings");

    await fake.emit(fake.click(NETWORK_BIOMES[0], OWNER, ["r-ping"]));
    expect(pings).toEqual([{ biome: NETWORK_BIOMES[0], roleId: "r-ping" }]);
    await fake.emit(fake.click("skip", OWNER));
    expect(text(fake.lastPayload())).toContain("Announcements");

    await fake.emit(fake.click("skip", OWNER));
    expect(text(fake.lastPayload())).toContain("Invite");

    fake.modalResult = async () => ({ values: { url: "not a link" }, ack: fake.modalSubmit(OWNER) });
    await fake.emit(fake.click("set", OWNER));
    expect(fake.notifies).toHaveLength(2);
    expect(text(fake.lastPayload())).toContain("Invite");

    fake.modalResult = async () => ({ values: { url: "https://discord.gg/solhunters" }, ack: fake.modalSubmit(OWNER) });
    await fake.emit(fake.click("set", OWNER));
    expect(updates.at(-1)).toEqual({ inviteUrl: "https://discord.gg/solhunters" });
    expect(await resultP).toBe("finished");
    expect(text(fake.lastPayload())).toContain("saved");
});

test("biomehunt.net-config: Cancel ends the flow", async () => {
    const { deps } = fakeDeps();
    const fake = createFakeViewTransport();
    const resultP = fake.run(
        networkConfigFlow(deps, "g1", async () => EmbedFormatter.success("saved")),
        undefined,
        OWNER,
    );
    await fake.flush();
    await fake.emit(fake.click("cancel", OWNER));
    expect(await resultP).toBe("cancelled");
    expect(text(fake.lastPayload())).toContain("Network setup cancelled.");
});

/** A role select opens with nothing selected unless it carries default values - and Discord only fires on a change, so an empty select could never be cleared. */
function defaultRoleIds(payload: ViewPayload, key: string): string[] {
    const select = flatten(payload).find((c) => c.custom_id?.endsWith(`:${key}`)) as { default_values?: Array<{ id: string }> } | undefined;
    return (select?.default_values ?? []).map((v) => v.id);
}

test("biomehunt.net-config: ping and announcement selects pre-select the current role so it can be cleared", async () => {
    const { deps, pings, updates } = fakeDeps();
    deps.getNetworkGuild = async () =>
        ({ network_channel_id: null, staff_channel_id: null, staff_role_id: null, announce_role_id: "r-ann", invite_url: null }) as never;
    deps.getNetworkPings = async () => [{ guild_id: "g1", biome: NETWORK_BIOMES[0], role_id: "r-old" }];
    const fake = createFakeViewTransport();
    void fake.run(
        networkConfigFlow(deps, "g1", async () => EmbedFormatter.success("saved")),
        undefined,
        OWNER,
    );
    await fake.flush();

    await fake.emit(fake.click("skip", OWNER)); // channel -> staff
    await fake.emit(fake.click("skip", OWNER)); // staff -> pings
    expect(defaultRoleIds(fake.lastPayload(), NETWORK_BIOMES[0])).toEqual(["r-old"]);
    expect(defaultRoleIds(fake.lastPayload(), NETWORK_BIOMES[1])).toEqual([]);

    await fake.emit(fake.click(NETWORK_BIOMES[0], OWNER, []));
    expect(pings).toEqual([{ biome: NETWORK_BIOMES[0], roleId: null }]);
    expect(defaultRoleIds(fake.lastPayload(), NETWORK_BIOMES[0])).toEqual([]);

    await fake.emit(fake.click("skip", OWNER)); // pings -> announcements
    expect(defaultRoleIds(fake.lastPayload(), "role")).toEqual(["r-ann"]);
    await fake.emit(fake.click("role", OWNER, []));
    expect(updates).toContainEqual({ announceRoleId: null });
});
