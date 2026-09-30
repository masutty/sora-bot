import { expect, test } from "bun:test";
import { config } from "@/config";
import { createFakeViewTransport, type ViewPayload } from "@/define";
import type { BiomeForwardRow } from "../types";
import { type ForwardListDeps, forwardListView } from "./forward-list.view";

const OWNER = "owner";
const GUILD_ID = "g1";

type Json = { custom_id?: string; disabled?: boolean; content?: string; components?: Json[]; accessory?: Json };

/** Every component on the message, as plain JSON, depth-first - same local test glue as reroll.view.test.ts. */
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

function comp(payload: ViewPayload, key: string): Json {
    const found = flatten(payload).find((c) => c.custom_id?.endsWith(`:${key}`));
    if (!found) throw new Error(`No component "${key}"`);
    return found;
}

/** A `ForwardListDeps` that never touches the DB - forwards live in a plain in-memory array. */
function fakeDeps(initial: BiomeForwardRow[] = []) {
    let forwards = [...initial];
    const setCalls: Array<{ guildId: string; biome: string; channelId: string; roleId: string | null; delayS?: number }> = [];
    const removeCalls: Array<{ guildId: string; biome: string }> = [];
    const deps: ForwardListDeps = {
        getForwards: async () => forwards,
        setForward: async (guildId, biome, channelId, roleId, delayS) => {
            setCalls.push({ guildId, biome, channelId, roleId, ...(delayS !== undefined ? { delayS } : {}) });
            forwards = [...forwards.filter((f) => f.biome !== biome), { guild_id: guildId, biome, channel_id: channelId, role_id: roleId }];
        },
        removeForward: async (guildId, biome) => {
            removeCalls.push({ guildId, biome });
            forwards = forwards.filter((f) => f.biome !== biome);
        },
    };
    return { deps, setCalls, removeCalls };
}

test("biomehunt.forward-list (close): starts empty, Create -> pick biome+channel -> Confirm creates the forward and returns to the list", async () => {
    const { deps, setCalls } = fakeDeps();
    const fake = createFakeViewTransport();
    const resultP = fake.run(forwardListView(deps, "close"), { guildId: GUILD_ID }, OWNER);
    await fake.flush();

    expect(text(fake.lastPayload())).toContain("None configured yet.");
    expect(comp(fake.lastPayload(), "remove").disabled).toBe(true);

    await fake.emit(fake.click("add", OWNER));
    expect(text(fake.lastPayload())).toContain("Create Biome Forward");
    expect(comp(fake.lastPayload(), "confirm").disabled).toBe(true);

    await fake.emit(fake.click("biome", OWNER, ["HELL"]));
    expect(comp(fake.lastPayload(), "confirm").disabled).toBe(true); // channel still missing

    await fake.emit(fake.click("channel", OWNER, ["c1"]));
    expect(comp(fake.lastPayload(), "confirm").disabled).toBe(false);

    await fake.emit(fake.click("confirm", OWNER));
    expect(setCalls).toEqual([{ guildId: GUILD_ID, biome: "HELL", channelId: "c1", roleId: null }]);
    expect(text(fake.lastPayload())).toContain("Hell - <#c1>");
    expect(comp(fake.lastPayload(), "remove").disabled).toBe(false);

    await fake.emit(fake.click("close", OWNER));
    expect(await resultP).toBeUndefined();
});

test('biomehunt.forward-list (close): idling past the timeout shows "Menu timed out.", not just the last screen stripped', async () => {
    const { deps } = fakeDeps();
    const fake = createFakeViewTransport();
    const resultP = fake.run(forwardListView(deps, "close"), { guildId: GUILD_ID }, OWNER);
    await fake.flush();

    await fake.clock.advance(config.ui.flowStepTimeoutMs);

    expect(await resultP).toBeUndefined();
    expect(text(fake.lastPayload())).toContain("Menu timed out.");
});

test("biomehunt.forward-list (close): Create -> Cancel creates nothing", async () => {
    const { deps, setCalls } = fakeDeps();
    const fake = createFakeViewTransport();
    void fake.run(forwardListView(deps, "close"), { guildId: GUILD_ID }, OWNER);
    await fake.flush();

    await fake.emit(fake.click("add", OWNER));
    await fake.emit(fake.click("cancel", OWNER));

    expect(setCalls).toHaveLength(0);
    expect(text(fake.lastPayload())).toContain("None configured yet.");
});

test("biomehunt.forward-list (close): Remove -> typed number retries on invalid, then removes on a valid one", async () => {
    const existing: BiomeForwardRow[] = [{ guild_id: GUILD_ID, biome: "HELL", channel_id: "c1", role_id: null }];
    const { deps, removeCalls } = fakeDeps(existing);
    const fake = createFakeViewTransport();
    void fake.run(forwardListView(deps, "close"), { guildId: GUILD_ID }, OWNER);
    await fake.flush();

    await fake.emit(fake.click("remove", OWNER));
    expect(text(fake.lastPayload())).toContain("1. Hell - <#c1>");

    await fake.emit(fake.text(OWNER, "5"));
    expect(fake.notifies).toHaveLength(1);
    expect(fake.notifies[0].content).toContain("Please type a number between 1 and 1.");
    expect(removeCalls).toHaveLength(0);
    expect(text(fake.lastPayload())).toContain("1. Hell - <#c1>"); // still on the remove screen

    await fake.emit(fake.text(OWNER, "1"));
    expect(removeCalls).toEqual([{ guildId: GUILD_ID, biome: "HELL" }]);
    expect(text(fake.lastPayload())).toContain("None configured yet.");
});

test("biomehunt.forward-list (close): Remove -> Back removes nothing", async () => {
    const existing: BiomeForwardRow[] = [{ guild_id: GUILD_ID, biome: "HELL", channel_id: "c1", role_id: null }];
    const { deps, removeCalls } = fakeDeps(existing);
    const fake = createFakeViewTransport();
    void fake.run(forwardListView(deps, "close"), { guildId: GUILD_ID }, OWNER);
    await fake.flush();

    await fake.emit(fake.click("remove", OWNER));
    await fake.emit(fake.click("back", OWNER));

    expect(removeCalls).toHaveLength(0);
    expect(text(fake.lastPayload())).not.toContain("Remove Forward"); // back on the list, not the remove screen
    expect(text(fake.lastPayload())).toContain("Hell - <#c1>");
});

test("biomehunt.forward-list (step): Back/Skip/Cancel resolve the matching StepResult; Back is disabled without canGoBack", async () => {
    const { deps } = fakeDeps();
    const fake = createFakeViewTransport();
    const resultP = fake.run(forwardListView(deps, "step"), { guildId: GUILD_ID, canGoBack: false }, OWNER);
    await fake.flush();

    expect(comp(fake.lastPayload(), "back").disabled).toBe(true);

    await fake.emit(fake.click("skip", OWNER));
    expect(await resultP).toEqual({ kind: "skip" });
});

test("biomehunt.forward-list (step): Back resolves {kind: 'back'} when canGoBack is true", async () => {
    const { deps } = fakeDeps();
    const fake = createFakeViewTransport();
    const resultP = fake.run(forwardListView(deps, "step"), { guildId: GUILD_ID, canGoBack: true }, OWNER);
    await fake.flush();

    expect(comp(fake.lastPayload(), "back").disabled).toBe(false);
    await fake.emit(fake.click("back", OWNER));
    expect(await resultP).toEqual({ kind: "back" });
});

test("biomehunt.forward-list (step): Cancel resolves {kind: 'cancel'}", async () => {
    const { deps } = fakeDeps();
    const fake = createFakeViewTransport();
    const resultP = fake.run(forwardListView(deps, "step"), { guildId: GUILD_ID }, OWNER);
    await fake.flush();

    await fake.emit(fake.click("cancel", OWNER));
    expect(await resultP).toEqual({ kind: "cancel" });
});

test("biomehunt.delayed-forward-list: Create also requires a delay, and passes it through to setForward", async () => {
    const { deps, setCalls } = fakeDeps();
    const fake = createFakeViewTransport();
    void fake.run(forwardListView(deps, "close", "delayed"), { guildId: GUILD_ID }, OWNER);
    await fake.flush();

    expect(text(fake.lastPayload())).toContain("Delayed Biome Forwards");
    await fake.emit(fake.click("add", OWNER));
    expect(text(fake.lastPayload())).toContain("Create Delayed Biome Forward");

    await fake.emit(fake.click("biome", OWNER, ["HELL"]));
    await fake.emit(fake.click("channel", OWNER, ["c1"]));
    expect(comp(fake.lastPayload(), "confirm").disabled).toBe(true); // delay still missing

    await fake.emit(fake.click("delay", OWNER, ["30"]));
    expect(comp(fake.lastPayload(), "confirm").disabled).toBe(false);

    await fake.emit(fake.click("confirm", OWNER));
    expect(setCalls).toEqual([{ guildId: GUILD_ID, biome: "HELL", channelId: "c1", roleId: null, delayS: 30 }]);
});
