import { afterEach, expect, test } from "bun:test";
import { createFakeViewTransport, type ViewPayload } from "@/define";
import { getAllBiomes, resetBiomeRegistry, setBiomeRegistry } from "../constants/biomes.constants";
import { type BiomeDelayedForwardRow, type BiomeForwardRow, NetworkStatus } from "../types";
import { buildTestForwardPost } from "./forward-post.view";
import { FORWARDS_PER_PAGE, tabBiomes } from "./forwards.screens";
import { type ForwardsDeps, forwardsView } from "./forwards.view";

const OWNER = "owner";
const GUILD = "g1";

type Json = {
    custom_id?: string;
    label?: string;
    disabled?: boolean;
    content?: string;
    components?: Json[];
    accessory?: Json;
    default_values?: { id: string }[];
    min_values?: number;
    max_values?: number;
    options?: { value: string; default?: boolean }[];
};

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

const text = (payload: ViewPayload) =>
    flatten(payload)
        .map((c) => c.content ?? "")
        .filter(Boolean)
        .join("\n");

const keys = (payload: ViewPayload) => flatten(payload).flatMap((c) => (c.custom_id ? [c.custom_id.split(":").slice(2).join(":")] : []));
const labels = (payload: ViewPayload) => flatten(payload).flatMap((c) => (c.label ? [c.label] : []));
const component = (payload: ViewPayload, key: string) => flatten(payload).find((c) => c.custom_id?.endsWith(`:${key}`));

const fwd = (biome: string, channelId: string, roleId: string | null = null): BiomeForwardRow => ({
    guild_id: GUILD,
    biome,
    channel_id: channelId,
    role_id: roleId,
});
const late = (biome: string, channelId: string, roleId: string | null, delayS: number): BiomeDelayedForwardRow => ({
    ...fwd(biome, channelId, roleId),
    delay_s: delayS,
});

interface Setup {
    forwards?: BiomeForwardRow[];
    delayed?: BiomeDelayedForwardRow[];
    blocked?: string[];
    network?: NetworkStatus;
    failTest?: boolean;
}

function fakeDeps(setup: Setup = {}) {
    const calls: unknown[][] = [];
    const data = { forwards: [...(setup.forwards ?? [])], delayed: [...(setup.delayed ?? [])] };
    const deps: ForwardsDeps = {
        getForwards: async () => data.forwards,
        getDelayedForwards: async () => data.delayed,
        setForward: async (biome, channelId, roleId) => {
            calls.push(["setForward", biome, channelId, roleId]);
            data.forwards = [...data.forwards.filter((f) => f.biome !== biome), fwd(biome, channelId, roleId)];
        },
        removeForward: async (biome) => {
            calls.push(["removeForward", biome]);
            data.forwards = data.forwards.filter((f) => f.biome !== biome);
        },
        setDelayed: async (biome, channelId, roleId, delayS) => {
            calls.push(["setDelayed", biome, channelId, roleId, delayS]);
            data.delayed = [...data.delayed.filter((f) => f.biome !== biome), late(biome, channelId, roleId, delayS)];
        },
        removeDelayed: async (biome) => {
            calls.push(["removeDelayed", biome]);
            data.delayed = data.delayed.filter((f) => f.biome !== biome);
        },
        canPost: async (channelId) => !(setup.blocked ?? []).includes(channelId),
        networkStatus: async () => setup.network ?? NetworkStatus.NONE,
        sendTest: async (biome, adminId) => {
            if (setup.failTest) throw new Error("nope");
            calls.push(["sendTest", biome, adminId]);
        },
    };
    return { deps, calls, data };
}

async function open(setup: Setup = {}) {
    const { deps, calls, data } = fakeDeps(setup);
    const fake = createFakeViewTransport();
    void fake.run(forwardsView(deps), undefined, OWNER);
    await fake.flush();
    return { fake, calls, data };
}

const rareSlot = (biome: string) => tabBiomes("rare").indexOf(biome);

afterEach(() => resetBiomeRegistry());

test("admin category never shows", async () => {
    const [first] = getAllBiomes();
    setBiomeRegistry([...getAllBiomes(), { ...first, key: "SECRETEVENT", label: "Secret Admin", category: "admin" }]);
    const { fake } = await open();
    const payload = fake.lastPayload();
    expect(labels(payload)).toEqual(expect.arrayContaining(["Weather", "Biomes", "Events", "Rare"]));
    expect(keys(payload).some((k) => k.includes("admin"))).toBe(false);
    for (const tab of ["weather", "biome", "event", "rare"]) {
        await fake.emit(fake.click(`tab:${tab}`, OWNER));
        expect(text(fake.lastPayload())).not.toContain("Secret Admin");
    }
});

test("disabled biomes are skipped and pages hold five", async () => {
    const entries = getAllBiomes();
    const victim = tabBiomes("weather")[0];
    setBiomeRegistry(entries.map((e) => (e.key === victim ? { ...e, enabled: false } : e)));
    const { fake } = await open();
    await fake.emit(fake.click("tab:weather", OWNER));
    const t = text(fake.lastPayload());
    expect(t).not.toContain(`**${entries.find((e) => e.key === victim)?.label}**`);
    expect(flatten(fake.lastPayload()).filter((c) => c.custom_id?.includes(":edit:")).length).toBeLessThanOrEqual(FORWARDS_PER_PAGE);
});

test("rare tab opens first and shows both lines of a row", async () => {
    const { fake } = await open({ forwards: [fwd("GLITCHED", "c1", "r1")], delayed: [late("GLITCHED", "c2", "r2", 30)] });
    const t = text(fake.lastPayload());
    expect(t).toContain("**Forwards · Rare**");
    expect(t).toContain("**Glitched**\nNow → <#c1> · <@&r1>\nAfter 30s → <#c2> · <@&r2>");
});

test('delayed-only row shows "not forwarded"', async () => {
    const { fake } = await open({ delayed: [late("GLITCHED", "c2", "r2", 45)] });
    expect(text(fake.lastPayload())).toContain("**Glitched**\nNow → not forwarded\nAfter 45s → <#c2> · <@&r2>");
});

test("a biome without forwards says so and offers Set up", async () => {
    const { fake } = await open({ forwards: [fwd("GLITCHED", "c1")] });
    expect(text(fake.lastPayload())).toContain("**Dreamspace**\n-# Not forwarded");
    expect(labels(fake.lastPayload())).toEqual(expect.arrayContaining(["Edit", "Set up"]));
});

test("network note hidden when status is none", async () => {
    const { fake } = await open({ network: NetworkStatus.NONE });
    expect(text(fake.lastPayload())).not.toContain("The Network needs");
    expect(text(fake.lastPayload())).toContain("Not forwarded");
});

test("network note shows for pending and member, on rare only", async () => {
    for (const network of [NetworkStatus.PENDING, NetworkStatus.MEMBER]) {
        const { fake } = await open({ network, forwards: [fwd("GLITCHED", "c1")] });
        expect(text(fake.lastPayload())).toContain("**Dreamspace**\n⚠️ Not forwarded\n-# The Network needs a forward for every rare biome.");
        expect(text(fake.lastPayload())).not.toContain("**Glitched**\n⚠️");
        await fake.emit(fake.click("tab:weather", OWNER));
        expect(text(fake.lastPayload())).not.toContain("The Network needs");
    }
});

test("can't-post flagged", async () => {
    const { fake } = await open({ forwards: [fwd("CYBERSPACE", "old")], blocked: ["old"] });
    expect(text(fake.lastPayload())).toContain("**Cyberspace**\n⚠️ Can't post in <#old>\n-# The bot lost access to this channel.");
});

test("non-rare editor has no delayed selects", async () => {
    const weather = tabBiomes("weather");
    const { fake } = await open();
    await fake.emit(fake.click("tab:weather", OWNER));
    await fake.emit(fake.click("edit:0", OWNER));
    const k = keys(fake.lastPayload());
    expect(k).toEqual(expect.arrayContaining(["nowChannel", "nowRole"]));
    expect(k.some((x) => x.startsWith("late"))).toBe(false);
    expect(weather.length).toBeGreaterThan(0);
});

test("rare editor is pre-filled and saves each select", async () => {
    const { fake, calls } = await open({ forwards: [fwd("GLITCHED", "c1", "r1")], delayed: [late("GLITCHED", "c2", "r2", 30)] });
    await fake.emit(fake.click(`edit:${rareSlot("GLITCHED")}`, OWNER));
    const payload = fake.lastPayload();
    expect(component(payload, "nowChannel")?.min_values).toBe(0);
    expect(component(payload, "nowChannel")?.default_values?.[0]?.id).toBe("c1");
    expect(component(payload, "nowRole")?.default_values?.[0]?.id).toBe("r1");
    expect(component(payload, "lateChannel")?.default_values?.[0]?.id).toBe("c2");
    expect(component(payload, "lateRole")?.default_values?.[0]?.id).toBe("r2");
    expect(component(payload, "lateDelay")?.options?.find((o) => o.default)?.value).toBe("30");

    await fake.emit(fake.click("nowRole", OWNER, []));
    await fake.emit(fake.click("lateDelay", OWNER, ["45"]));
    await fake.emit(fake.click("lateChannel", OWNER, ["c3"]));
    expect(calls).toEqual([
        ["setForward", "GLITCHED", "c1", null],
        ["setDelayed", "GLITCHED", "c2", "r2", 45],
        ["setDelayed", "GLITCHED", "c3", "r2", 45],
    ]);
});

test("clearing the delayed channel asks, then removes the delayed forward only", async () => {
    const { fake, calls } = await open({ forwards: [fwd("GLITCHED", "c1")], delayed: [late("GLITCHED", "c2", null, 30)] });
    await fake.emit(fake.click(`edit:${rareSlot("GLITCHED")}`, OWNER));
    await fake.emit(fake.click("lateChannel", OWNER, []));
    expect(text(fake.lastPayload())).toContain("Stop the delayed forward for Glitched?");
    expect(calls).toHaveLength(0);
    await fake.emit(fake.click("yes", OWNER));
    expect(calls).toEqual([["removeDelayed", "GLITCHED"]]);
});

test("clearing the Now channel asks, and Cancel keeps the forward", async () => {
    const { fake, calls } = await open({ forwards: [fwd("GLITCHED", "c1", "r1")] });
    await fake.emit(fake.click(`edit:${rareSlot("GLITCHED")}`, OWNER));
    await fake.emit(fake.click("nowChannel", OWNER, []));
    expect(text(fake.lastPayload())).toContain("Stop forwarding Glitched now?");
    await fake.emit(fake.click("no", OWNER));
    expect(calls).toHaveLength(0);
    expect(component(fake.lastPayload(), "nowChannel")?.default_values?.[0]?.id).toBe("c1");
});

test("clearing the Now channel and confirming removes the Now forward", async () => {
    const { fake, calls } = await open({ forwards: [fwd("GLITCHED", "c1", "r1")] });
    await fake.emit(fake.click(`edit:${rareSlot("GLITCHED")}`, OWNER));
    await fake.emit(fake.click("nowChannel", OWNER, []));
    await fake.emit(fake.click("yes", OWNER));
    expect(calls).toEqual([["removeForward", "GLITCHED"]]);
});

test("Cancel on the delayed clear keeps the delayed forward", async () => {
    const { fake, calls } = await open({ delayed: [late("GLITCHED", "c2", null, 30)] });
    await fake.emit(fake.click(`edit:${rareSlot("GLITCHED")}`, OWNER));
    await fake.emit(fake.click("lateChannel", OWNER, []));
    await fake.emit(fake.click("no", OWNER));
    expect(calls).toHaveLength(0);
    expect(component(fake.lastPayload(), "lateChannel")?.default_values?.[0]?.id).toBe("c2");
});

test("a role needs its channel first", async () => {
    const { fake, calls } = await open();
    await fake.emit(fake.click(`edit:${rareSlot("GLITCHED")}`, OWNER));
    await fake.emit(fake.click("nowRole", OWNER, ["r1"]));
    expect(fake.notifies.at(-1)?.content).toBe("Pick the channel first.");
    expect(calls).toHaveLength(0);
});

test("send a test passes the clicking admin", async () => {
    const { fake, calls } = await open({ forwards: [fwd("GLITCHED", "c1")] });
    await fake.emit(fake.click(`edit:${rareSlot("GLITCHED")}`, OWNER));
    await fake.emit(fake.click("test", OWNER));
    expect(calls).toEqual([["sendTest", "GLITCHED", OWNER]]);
    expect(fake.notifies.at(-1)?.content).toBe("Test post sent to <#c1>.");
});

test("a failed test says the bot can't post", async () => {
    const { fake } = await open({ forwards: [fwd("GLITCHED", "c1")], failTest: true });
    await fake.emit(fake.click(`edit:${rareSlot("GLITCHED")}`, OWNER));
    await fake.emit(fake.click("test", OWNER));
    expect(fake.notifies.at(-1)?.content).toBe("I couldn't post in <#c1>.");
});

test("test post allows no mentions and starts with the test line", () => {
    const post = buildTestForwardPost("GLITCHED", "r1", "admin1");
    expect(post.allowedMentions).toEqual({ parse: [] });
    const t = text(post);
    expect(t.split("\n")[0]).toBe("**🧪 Test - not a real find**");
    expect(t).toContain("Pings <@&r1> on a real find.");
    expect(t).toContain("-# Sent by <@admin1> from /admin forwarding. Nobody was pinged.");
});

test("stop forwarding removes both", async () => {
    const { fake, calls } = await open({ forwards: [fwd("GLITCHED", "c1")], delayed: [late("GLITCHED", "c2", null, 30)] });
    await fake.emit(fake.click(`edit:${rareSlot("GLITCHED")}`, OWNER));
    await fake.emit(fake.click("stop", OWNER));
    expect(text(fake.lastPayload())).toContain("Stop forwarding Glitched?");
    expect(text(fake.lastPayload())).toContain("Its Now and delayed forwards both stop.");
    expect(text(fake.lastPayload())).not.toContain("The Network needs");
    expect(calls).toHaveLength(0);
    await fake.emit(fake.click("yes", OWNER));
    expect(calls).toEqual([
        ["removeForward", "GLITCHED"],
        ["removeDelayed", "GLITCHED"],
    ]);
    expect(text(fake.lastPayload())).toContain("**Glitched**\n-# Not forwarded");
});

test("stop forwarding adds the Network note for a rare biome in the Network", async () => {
    const { fake } = await open({ network: NetworkStatus.MEMBER, forwards: [fwd("GLITCHED", "c1")] });
    await fake.emit(fake.click(`edit:${rareSlot("GLITCHED")}`, OWNER));
    await fake.emit(fake.click("stop", OWNER));
    expect(text(fake.lastPayload())).toContain("-# The Network needs a forward for every rare biome.");
});

test("set for all applies without asking when nothing is overwritten", async () => {
    const { fake, calls } = await open({ forwards: [fwd("GLITCHED", "c1", "r1")] });
    await fake.emit(fake.click("all", OWNER));
    expect(text(fake.lastPayload())).toContain("Applies to all 4. Each biome keeps its own ping.");
    await fake.emit(fake.click("allNow", OWNER, ["c1"]));
    await fake.emit(fake.click("apply", OWNER));
    expect(calls.filter((c) => c[0] === "setForward")).toHaveLength(3);
    expect(calls).not.toContainEqual(["setForward", "GLITCHED", "c1", "r1"]);
    expect(text(fake.lastPayload())).toContain("**Forwards · Rare**");
});

test("set for all lists only biomes that change", async () => {
    const { fake, calls } = await open({
        forwards: [fwd("GLITCHED", "new"), fwd("CYBERSPACE", "old")],
        delayed: [late("DREAMSPACE", "late-old", null, 45), late("GLITCHED", "late-new", null, 30)],
    });
    await fake.emit(fake.click("all", OWNER));
    await fake.emit(fake.click("allNow", OWNER, ["new"]));
    await fake.emit(fake.click("allLate", OWNER, ["late-new"]));
    await fake.emit(fake.click("allDelay", OWNER, ["30"]));
    await fake.emit(fake.click("apply", OWNER));
    const t = text(fake.lastPayload());
    expect(t).toContain("Apply to all 4 rare biomes?");
    expect(t).toContain("**Now:** Cyberspace is currently forwarding to <#old>.");
    expect(t).not.toContain("Glitched is currently");
    expect(t).toContain("**After a delay:** Dreamspace is currently forwarding to <#late-old> after 45s.");
    expect(calls).toHaveLength(0);
    await fake.emit(fake.click("yes", OWNER));
    expect(calls.filter((c) => c[0] === "setForward")).toHaveLength(3);
    expect(calls.filter((c) => c[0] === "setDelayed")).toHaveLength(3);
});

test("set for all diff uses a fresh read", async () => {
    const { fake, data } = await open({ forwards: [fwd("CYBERSPACE", "new")] });
    await fake.emit(fake.click("all", OWNER));
    await fake.emit(fake.click("allNow", OWNER, ["new"]));
    data.forwards = [fwd("CYBERSPACE", "changed-meanwhile")];
    await fake.emit(fake.click("apply", OWNER));
    expect(text(fake.lastPayload())).toContain("**Now:** Cyberspace is currently forwarding to <#changed-meanwhile>.");
});

test("copy Now pings puts each Now role on its delayed forward", async () => {
    const { fake, calls } = await open({ forwards: [fwd("GLITCHED", "c1", "r1")] });
    await fake.emit(fake.click("all", OWNER));
    await fake.emit(fake.click("allLate", OWNER, ["late"]));
    await fake.emit(fake.click("allCopy", OWNER));
    await fake.emit(fake.click("apply", OWNER));
    expect(calls).toContainEqual(["setDelayed", "GLITCHED", "late", "r1", 30]);
    expect(calls).toContainEqual(["setDelayed", "DREAMSPACE", "late", null, 30]);
});

test("set for all with nothing to write says so and stays", async () => {
    const { fake, calls } = await open();
    await fake.emit(fake.click("all", OWNER));
    await fake.emit(fake.click("apply", OWNER));
    expect(fake.notifies.at(-1)?.content).toBe("Nothing to change.");
    expect(text(fake.lastPayload())).toContain("Set for all");
    expect(calls).toHaveLength(0);
});

test("set for all with the same values already stored changes nothing", async () => {
    const { fake, calls } = await open({ forwards: tabBiomes("rare").map((b) => fwd(b, "c1")) });
    await fake.emit(fake.click("all", OWNER));
    await fake.emit(fake.click("allNow", OWNER, ["c1"]));
    await fake.emit(fake.click("apply", OWNER));
    expect(fake.notifies.at(-1)?.content).toBe("Nothing to change.");
    expect(calls).toHaveLength(0);
});

test("copy Now pings lists a delayed role it would change", async () => {
    const { fake, calls } = await open({ forwards: [fwd("GLITCHED", "c1", "rNow")], delayed: [late("GLITCHED", "c2", "rOld", 30)] });
    await fake.emit(fake.click("all", OWNER));
    await fake.emit(fake.click("allCopy", OWNER));
    await fake.emit(fake.click("apply", OWNER));
    expect(text(fake.lastPayload())).toContain("**After a delay:** Glitched pings <@&rNow> instead of <@&rOld>.");
    expect(calls).toHaveLength(0);
    await fake.emit(fake.click("yes", OWNER));
    expect(calls).toEqual([["setDelayed", "GLITCHED", "c2", "rNow", 30]]);
});

test("non-rare set for all has no delayed block", async () => {
    const { fake } = await open();
    await fake.emit(fake.click("tab:weather", OWNER));
    await fake.emit(fake.click("all", OWNER));
    expect(keys(fake.lastPayload())).not.toContain("allLate");
    expect(keys(fake.lastPayload())).not.toContain("allCopy");
});
