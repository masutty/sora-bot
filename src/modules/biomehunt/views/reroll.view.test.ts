import { expect, test } from "bun:test";
import { createFakeViewTransport, type ViewPayload } from "@/define";
import { settings } from "../settings";
import { REROLL_COST, type RerollDeps, rerollView } from "./reroll.view";

const OWNER = "owner";

type Json = { custom_id?: string; disabled?: boolean; content?: string; components?: Json[]; accessory?: Json };

/** Every component on the message, as plain JSON, depth-first - same shape as the framework's own
 * helpers.test.ts, kept local since it's test-only glue. */
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

/** Every text on the message (content + text displays), joined by newlines. */
function text(payload: ViewPayload): string {
    return [payload.content ?? "", ...flatten(payload).map((c) => c.content ?? "")].filter(Boolean).join("\n");
}

/** The component bound to `key` on the current message, as JSON. */
function comp(payload: ViewPayload, key: string): Json {
    const found = flatten(payload).find((c) => c.custom_id?.endsWith(`:${key}`));
    if (!found) throw new Error(`No component "${key}"`);
    return found;
}

/** A `RerollDeps` that never touches the DB/webhook: seeds are tracked in-memory, draws come from a
 * fixed sequence (so tests can assert on the exact Flower shown), and every call is counted. */
function fakeDeps(startingSeeds: number, draws: string[] = ["POPPY", "ROSE_BUSH", "ALLIUM"]) {
    let seeds = startingSeeds;
    let drawIndex = 0;
    const applyCalls: string[] = [];
    let spendCalls = 0;
    const deps: RerollDeps = {
        spendSeeds: async () => {
            spendCalls++;
            if (seeds < REROLL_COST) return { ok: false };
            seeds -= REROLL_COST;
            return { ok: true, seeds };
        },
        drawFlower: () => draws[drawIndex++ % draws.length],
        applyFlower: async (flower) => {
            applyCalls.push(flower);
        },
    };
    return { deps, applyCalls, get spendCalls() { return spendCalls; } };
}

test("biomehunt.reroll: confirm -> roll -> apply charges once per draw and applies exactly once", async () => {
    const { deps, applyCalls } = fakeDeps(200);
    const fake = createFakeViewTransport();
    const resultP = fake.run(rerollView(deps), { seeds: 200, flower: "DANDELION" }, OWNER);
    await fake.flush();

    expect(text(fake.lastPayload())).toContain(`Reroll your Flower for ${REROLL_COST} 🌱 Seeds?`);
    expect(text(fake.lastPayload())).toContain("Seeds: 200");

    await fake.emit(fake.click("confirm", OWNER));
    expect(text(fake.lastPayload())).toContain("🎲 New Flower!");
    expect(text(fake.lastPayload())).toContain("Seeds: 150");
    expect(applyCalls.length).toBe(0);

    await fake.emit(fake.click("again", OWNER));
    expect(text(fake.lastPayload())).toContain("Seeds: 100");

    await fake.emit(fake.click("apply", OWNER));
    expect(applyCalls).toEqual(["ROSE_BUSH"]);
    expect(text(fake.lastPayload())).toContain("✅ Flower applied!");
    expect(text(fake.lastPayload())).toContain("Seeds: 100");
    expect(await resultP).toBeUndefined();
});

test("biomehunt.reroll: cancelling the confirm screen spends nothing", async () => {
    const { deps, applyCalls, spendCalls } = fakeDeps(200);
    const fake = createFakeViewTransport();
    const resultP = fake.run(rerollView(deps), { seeds: 200, flower: "DANDELION" }, OWNER);
    await fake.flush();

    await fake.emit(fake.click("cancel", OWNER));

    expect(text(fake.lastPayload())).toContain("Reroll cancelled - nothing was spent.");
    expect(spendCalls).toBe(0);
    expect(applyCalls.length).toBe(0);
    expect(await resultP).toBeUndefined();
});

test("biomehunt.reroll: idle timeout on the confirm screen spends nothing", async () => {
    const { deps, applyCalls, spendCalls } = fakeDeps(200);
    const fake = createFakeViewTransport();
    const resultP = fake.run(rerollView(deps), { seeds: 200, flower: "DANDELION" }, OWNER);
    await fake.flush();

    await fake.clock.advance(settings.ui.rerollIdleMs);

    expect(await resultP).toBeUndefined();
    expect(text(fake.lastPayload())).toContain("Reroll timed out - nothing was spent.");
    expect(spendCalls).toBe(0);
    expect(applyCalls.length).toBe(0);
});

test("biomehunt.reroll: idle timeout while rolling auto-applies the current draw exactly once", async () => {
    const { deps, applyCalls } = fakeDeps(200);
    const fake = createFakeViewTransport();
    const resultP = fake.run(rerollView(deps), { seeds: 200, flower: "DANDELION" }, OWNER);
    await fake.flush();
    await fake.emit(fake.click("confirm", OWNER));

    await fake.clock.advance(settings.ui.rerollIdleMs);

    expect(await resultP).toBeUndefined();
    expect(applyCalls).toEqual(["POPPY"]);
    expect(text(fake.lastPayload())).toContain("✅ Flower applied!");
});

test("biomehunt.reroll: a draw that can't afford another roll disables Roll Again", async () => {
    const { deps } = fakeDeps(REROLL_COST);
    const fake = createFakeViewTransport();
    void fake.run(rerollView(deps), { seeds: REROLL_COST, flower: "DANDELION" }, OWNER);
    await fake.flush();

    await fake.emit(fake.click("confirm", OWNER));

    expect(comp(fake.lastPayload(), "again").disabled).toBe(true);
});

test("biomehunt.reroll: a BiomeHuntError from applyFlower shows its own message, others show the generic one", async () => {
    const { BiomeHuntError } = await import("../types");
    const { deps } = fakeDeps(200);
    deps.applyFlower = async () => {
        throw new BiomeHuntError("Couldn't access that user's macro channel.");
    };
    const fake = createFakeViewTransport();
    void fake.run(rerollView(deps), { seeds: 200, flower: "DANDELION" }, OWNER);
    await fake.flush();
    await fake.emit(fake.click("confirm", OWNER));

    await fake.emit(fake.click("apply", OWNER));
    expect(text(fake.lastPayload())).toContain("Couldn't access that user's macro channel.");

    const { deps: deps2 } = fakeDeps(200);
    deps2.applyFlower = async () => {
        throw new Error("boom");
    };
    const fake2 = createFakeViewTransport();
    void fake2.run(rerollView(deps2), { seeds: 200, flower: "DANDELION" }, OWNER);
    await fake2.flush();
    await fake2.emit(fake2.click("confirm", OWNER));
    await fake2.emit(fake2.click("apply", OWNER));
    expect(text(fake2.lastPayload())).toContain("Something went wrong applying your Flower.");
});
