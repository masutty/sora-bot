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
 * fixed sequence (so tests can assert on the exact Flower shown), and every call is counted. `spend`
 * is a plain mutable object (not a getter) SPECIFICALLY so destructuring it in a test still keeps a
 * live reference to the same counter - destructuring a getter instead would freeze its value at
 * that instant, making every later assertion on it vacuous. */
function fakeDeps(startingSeeds: number, draws: string[] = ["POPPY", "ROSE_BUSH", "ALLIUM"]) {
    let seeds = startingSeeds;
    let drawIndex = 0;
    const applyCalls: string[] = [];
    const spend = { count: 0 };
    const deps: RerollDeps = {
        spendSeeds: async () => {
            spend.count++;
            if (seeds < REROLL_COST) return { ok: false };
            seeds -= REROLL_COST;
            return { ok: true, seeds };
        },
        drawFlower: () => draws[drawIndex++ % draws.length],
        applyFlower: async (flower) => {
            applyCalls.push(flower);
        },
    };
    return { deps, applyCalls, spend };
}

/** A promise a test can resolve on its own schedule - for asserting on what happens WHILE a
 * dependency call is still in flight (e.g. a slow webhook edit racing the idle timeout). */
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });
    return { promise, resolve };
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
    const { deps, applyCalls, spend } = fakeDeps(200);
    const fake = createFakeViewTransport();
    const resultP = fake.run(rerollView(deps), { seeds: 200, flower: "DANDELION" }, OWNER);
    await fake.flush();

    await fake.emit(fake.click("cancel", OWNER));

    expect(text(fake.lastPayload())).toContain("Reroll cancelled - nothing was spent.");
    expect(spend.count).toBe(0);
    expect(applyCalls.length).toBe(0);
    expect(await resultP).toBeUndefined();
});

test("biomehunt.reroll: idle timeout on the confirm screen spends nothing", async () => {
    const { deps, applyCalls, spend } = fakeDeps(200);
    const fake = createFakeViewTransport();
    const resultP = fake.run(rerollView(deps), { seeds: 200, flower: "DANDELION" }, OWNER);
    await fake.flush();

    await fake.clock.advance(settings.ui.rerollIdleMs);

    expect(await resultP).toBeUndefined();
    expect(text(fake.lastPayload())).toContain("Reroll timed out - nothing was spent.");
    expect(spend.count).toBe(0);
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

// ─── Fix round 1: the idle timeout must not cut a running handler off mid-flight ───

test("biomehunt.reroll (fix round 1): Apply Now outlives a slow webhook edit - the idle timeout firing mid-apply doesn't cut it off or double-apply", async () => {
    const { deps, applyCalls } = fakeDeps(200);
    const gate = deferred<void>();
    deps.applyFlower = async (flower) => {
        await gate.promise;
        applyCalls.push(flower);
    };
    const fake = createFakeViewTransport();
    const resultP = fake.run(rerollView(deps), { seeds: 200, flower: "DANDELION" }, OWNER);
    await fake.flush();
    await fake.emit(fake.click("confirm", OWNER));
    await fake.emit(fake.click("apply", OWNER));
    expect(applyCalls.length).toBe(0); // the webhook edit is still in flight

    // The idle timer fires while "apply" is still running - it must be postponed, not applied
    // immediately (which would show a stale/expired screen while the real apply is still pending).
    await fake.clock.advance(settings.ui.rerollIdleMs);
    let settled = false;
    void resultP.then(() => (settled = true));
    await fake.flush();
    expect(settled).toBe(false);
    expect(applyCalls.length).toBe(0);

    gate.resolve();
    await fake.flush();

    expect(applyCalls).toEqual(["POPPY"]);
    expect(text(fake.lastPayload())).toContain("✅ Flower applied!");
    expect(await resultP).toBeUndefined();
});

test("biomehunt.reroll (fix round 1): a slow spendSeeds on confirm outlives the idle timeout - it moves to rolling once it resolves, instead of timing out mid-charge", async () => {
    const { deps, applyCalls } = fakeDeps(200);
    const gate = deferred<{ ok: true; seeds: number } | { ok: false }>();
    deps.spendSeeds = () => gate.promise;
    const fake = createFakeViewTransport();
    const resultP = fake.run(rerollView(deps), { seeds: 200, flower: "DANDELION" }, OWNER);
    await fake.flush();
    await fake.emit(fake.click("confirm", OWNER));

    // The idle timer fires while "confirm" is still awaiting spendSeeds.
    await fake.clock.advance(settings.ui.rerollIdleMs);
    gate.resolve({ ok: true, seeds: 150 });
    await fake.flush();

    expect(text(fake.lastPayload())).toContain("🎲 New Flower!");
    expect(text(fake.lastPayload())).not.toContain("Reroll timed out - nothing was spent.");

    // The session is still alive (a fresh full timeout was armed on settling) - a genuinely idle
    // "rolling" screen still auto-applies normally afterwards.
    await fake.clock.advance(settings.ui.rerollIdleMs);
    expect(await resultP).toBeUndefined();
    expect(applyCalls).toEqual(["POPPY"]);
    expect(text(fake.lastPayload())).toContain("✅ Flower applied!");
});
