import { expect, test } from "bun:test";
import { createFakeViewTransport, type ViewPayload } from "@/define";
import { FlowerRarity, RARITY_COLOR, rarityOneIn } from "../constants/flowers.constants";
import { settings } from "../settings";
import { REROLL_COST, type RerollDeps, rerollView } from "./reroll.view";

const OWNER = "owner";

type Json = {
    custom_id?: string;
    disabled?: boolean;
    style?: number;
    label?: string;
    accent_color?: number;
    content?: string;
    components?: Json[];
    accessory?: Json;
};

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

function container(payload: ViewPayload): Json {
    const found = flatten(payload).find((c) => c.accent_color !== undefined);
    if (!found) throw new Error("No container");
    return found;
}

/** A `RerollDeps` that never touches the DB/webhook/clock/random: seeds are tracked in-memory, draws
 * come from a fixed sequence, the "random" flavor pick is always the first entry, and every call is
 * counted. `spend` is a plain mutable object (not a getter) so destructuring keeps a live reference. */
function fakeDeps(startingSeeds: number, draws: string[] = ["POPPY", "ROSE_BUSH", "ALLIUM"]) {
    let seeds = startingSeeds;
    let drawIndex = 0;
    const applyCalls: string[] = [];
    const spend = { count: 0 };
    const deps: RerollDeps = {
        spendSeeds: async () => {
            spend.count++;
            if (seeds < REROLL_COST) return { ok: false, seeds };
            seeds -= REROLL_COST;
            return { ok: true, seeds };
        },
        drawFlower: () => draws[drawIndex++ % draws.length],
        applyFlower: async (flower) => {
            applyCalls.push(flower);
        },
        pick: (items) => items[0],
        now: () => 1_000_000_000,
    };
    return { deps, applyCalls, spend };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

const DEADLINE = `<t:${Math.floor((1_000_000_000 + settings.ui.rerollIdleMs) / 1000)}:R>`;

async function open(startingSeeds: number, flower: string | null, draws?: string[]) {
    const ctx = fakeDeps(startingSeeds, draws);
    const fake = createFakeViewTransport();
    const resultP = fake.run(rerollView(ctx.deps), { seeds: startingSeeds, flower }, OWNER);
    await fake.flush();
    return { ...ctx, fake, resultP };
}

test("rarityOneIn: odds come from the real draw chain", () => {
    expect(rarityOneIn(FlowerRarity.COMMON)).toBe("2");
    expect(rarityOneIn(FlowerRarity.UNCOMMON)).toBe("4");
    expect(rarityOneIn(FlowerRarity.RARE)).toBe("6");
    expect(rarityOneIn(FlowerRarity.EPIC)).toBe("10");
    expect(rarityOneIn(FlowerRarity.LEGENDARY)).toBe("33");
    expect(rarityOneIn(FlowerRarity.MYTHICAL)).toBe("1,000");
    expect(rarityOneIn(FlowerRarity.RNGESUS)).toBe("100,000");
});

test("reroll: confirm screen shows the current Flower, its rarity, the cost and the Keep button", async () => {
    const { fake } = await open(200, "ROSE_BUSH");
    const payload = fake.lastPayload();
    expect(container(payload).accent_color).toBe(RARITY_COLOR[FlowerRarity.UNCOMMON]);
    const t = text(payload);
    expect(t).toContain("## Rose Bush");
    expect(t).toContain("Uncommon");
    expect(t).toContain(`**Search for another Flower?**\nEach search digs up a random Flower for \`${REROLL_COST} 🌱\`.`);
    expect(t).not.toContain("Seeds:");
    expect(comp(payload, "confirm").style).toBe(3);
    expect(comp(payload, "cancel").style).toBe(2);
});

test("reroll: accent follows the shown Flower's rarity", async () => {
    const flowers: Array<[string, FlowerRarity]> = [
        ["POPPY", FlowerRarity.COMMON],
        ["LILAC", FlowerRarity.UNCOMMON],
        ["BLUE_ORCHID", FlowerRarity.RARE],
        ["TORCHFLOWER", FlowerRarity.EPIC],
        ["WITHER_ROSE", FlowerRarity.LEGENDARY],
        ["ALLIUM", FlowerRarity.MYTHICAL],
        ["GOLDEN_DANDELION", FlowerRarity.RNGESUS],
    ];
    for (const [flower, rarity] of flowers) {
        const { fake } = await open(200, flower);
        expect(container(fake.lastPayload()).accent_color).toBe(RARITY_COLOR[rarity]);
    }
});

test("reroll: no Flower yet still renders a card", async () => {
    const { fake } = await open(200, null);
    expect(text(fake.lastPayload())).toContain("No Flower yet");
});

test("reroll: search, search again, keep - spends per draw and applies once", async () => {
    const { fake, applyCalls, resultP } = await open(200, "DANDELION");
    await fake.emit(fake.click("confirm", OWNER));
    let t = text(fake.lastPayload());
    expect(t).toContain("## Poppy");
    expect(t).toContain("Common · 1 in 2");
    expect(t).toContain(`⏳ Kept ${DEADLINE}`);
    expect(t).not.toContain("Roll #");
    expect(comp(fake.lastPayload(), "again").style).toBe(1);
    expect(applyCalls.length).toBe(0);

    await fake.emit(fake.click("again", OWNER));
    t = text(fake.lastPayload());
    expect(t).toContain("## Rose Bush");
    expect(t).toContain("Uncommon · 1 in 4");

    await fake.emit(fake.click("apply", OWNER));
    expect(applyCalls).toEqual(["ROSE_BUSH"]);
    expect(text(fake.lastPayload())).toContain("🌱 You decided to keep your **Rose Bush**.");
    expect(await resultP).toBeUndefined();
});

test("reroll: keeping the current Flower on the confirm screen spends nothing", async () => {
    const { fake, applyCalls, spend, resultP } = await open(200, "DANDELION");
    expect(comp(fake.lastPayload(), "cancel").label).toBe("Keep Dandelion");
    await fake.emit(fake.click("cancel", OWNER));

    expect(text(fake.lastPayload())).toContain("🌱 You decided to keep your **Dandelion**.");
    expect(spend.count).toBe(0);
    expect(applyCalls.length).toBe(0);
    expect(await resultP).toBeUndefined();
});

test("reroll: idle timeout on the confirm screen spends nothing", async () => {
    const { fake, applyCalls, spend, resultP } = await open(200, "DANDELION");
    await fake.clock.advance(settings.ui.rerollIdleMs);

    expect(await resultP).toBeUndefined();
    expect(text(fake.lastPayload())).toContain("Reroll timed out - nothing was spent.");
    expect(spend.count).toBe(0);
    expect(applyCalls.length).toBe(0);
});

test("reroll: idle timeout after a find auto-applies it exactly once", async () => {
    const { fake, applyCalls, resultP } = await open(200, "DANDELION");
    await fake.emit(fake.click("confirm", OWNER));
    await fake.clock.advance(settings.ui.rerollIdleMs);

    expect(await resultP).toBeUndefined();
    expect(applyCalls).toEqual(["POPPY"]);
    expect(text(fake.lastPayload())).toContain("🌱 You decided to keep your **Poppy**.");
});

test("reroll: a find that can't afford another search disables Search again", async () => {
    const { fake } = await open(REROLL_COST, "DANDELION");
    await fake.emit(fake.click("confirm", OWNER));
    expect(comp(fake.lastPayload(), "again").disabled).toBe(true);
});

test("reroll: not enough Seeds on a fresh spend shows the standard error with real numbers", async () => {
    const { fake, deps, resultP } = await open(200, "DANDELION");
    deps.spendSeeds = async () => ({ ok: false, seeds: 30 });
    await fake.emit(fake.click("confirm", OWNER));

    const t = text(fake.lastPayload());
    expect(t).toContain(`You need \`${REROLL_COST} 🌱\` to search for a new Flower - you have \`30 🌱\`.`);
    expect(t).not.toContain("## ");
    expect(await resultP).toBeUndefined();
});

test("reroll: very rare find shows banner, flavor, red button; kept card keeps the banner", async () => {
    const { fake, applyCalls } = await open(200, "DANDELION", ["WITHER_ROSE"]);
    await fake.emit(fake.click("confirm", OWNER));

    const payload = fake.lastPayload();
    const t = text(payload);
    expect(t).toContain("\u001b[1;33m ★ LEGENDARY FIND ★ \u001b[0m");
    expect(t).toContain("\u001b[33mThis one doesn't grow in just any garden.");
    expect(t).toContain("Legendary · 1 in 33");
    expect(comp(payload, "again").style).toBe(4);

    await fake.emit(fake.click("apply", OWNER));
    expect(applyCalls).toEqual(["WITHER_ROSE"]);
    expect(text(fake.lastPayload())).toContain("LEGENDARY FIND");
    expect(text(fake.lastPayload())).toContain("keep your **Wither Rose**");
});

test("reroll: mythical and RNGesus banners use their own tag and flavor color", async () => {
    const m = await open(200, "DANDELION", ["ALLIUM"]);
    await m.fake.emit(m.fake.click("confirm", OWNER));
    expect(text(m.fake.lastPayload())).toContain("\u001b[1;31;40m ◆ MYTHICAL FIND ◆ \u001b[0m");
    expect(text(m.fake.lastPayload())).toContain("\u001b[31mGardeners talk about this one in whispers.");
    expect(text(m.fake.lastPayload())).toContain("Mythical · 1 in 1,000");

    const r = await open(200, "DANDELION", ["GOLDEN_DANDELION"]);
    await r.fake.emit(r.fake.click("confirm", OWNER));
    expect(text(r.fake.lastPayload())).toContain("\u001b[1;37;45m ✦ RNGESUS FIND ✦ \u001b[0m");
    expect(text(r.fake.lastPayload())).toContain("\u001b[35mRNGesus has blessed your garden.");
    expect(text(r.fake.lastPayload())).toContain("Rngesus · 1 in 100,000");
});

test("reroll: Search again on a very rare find asks first - Keep applies it", async () => {
    const { fake, applyCalls, spend } = await open(200, "DANDELION", ["WITHER_ROSE", "POPPY"]);
    await fake.emit(fake.click("confirm", OWNER));
    expect(spend.count).toBe(1);
    await fake.emit(fake.click("again", OWNER));

    expect(spend.count).toBe(1);
    const t = text(fake.lastPayload());
    expect(t).toContain("**Search again and lose your Wither Rose?**");
    expect(t).toContain(`⏳ Kept ${DEADLINE}`);
    expect(t).toContain("LEGENDARY FIND");
    expect(comp(fake.lastPayload(), "again").style).toBe(4);

    await fake.emit(fake.click("apply", OWNER));
    expect(applyCalls).toEqual(["WITHER_ROSE"]);
});

test("reroll: confirming the loss spends and draws a new Flower", async () => {
    const { fake, applyCalls, spend } = await open(200, "DANDELION", ["WITHER_ROSE", "POPPY"]);
    await fake.emit(fake.click("confirm", OWNER));
    await fake.emit(fake.click("again", OWNER));
    await fake.emit(fake.click("again", OWNER));

    expect(spend.count).toBe(2);
    const t = text(fake.lastPayload());
    expect(t).toContain("## Poppy");
    expect(t).not.toContain("FIND");
    expect(applyCalls.length).toBe(0);
});

test("reroll: idle during the loss confirmation still keeps the rare Flower once", async () => {
    const { fake, applyCalls, resultP } = await open(200, "DANDELION", ["WITHER_ROSE"]);
    await fake.emit(fake.click("confirm", OWNER));
    await fake.emit(fake.click("again", OWNER));
    await fake.clock.advance(settings.ui.rerollIdleMs);

    expect(await resultP).toBeUndefined();
    expect(applyCalls).toEqual(["WITHER_ROSE"]);
});

test("reroll: a BiomeHuntError from applyFlower shows its own message, others show the generic one", async () => {
    const { BiomeHuntError } = await import("../types");
    const a = await open(200, "DANDELION");
    a.deps.applyFlower = async () => {
        throw new BiomeHuntError("Couldn't access that user's macro channel.");
    };
    await a.fake.emit(a.fake.click("confirm", OWNER));
    await a.fake.emit(a.fake.click("apply", OWNER));
    expect(text(a.fake.lastPayload())).toContain("Couldn't access that user's macro channel.");

    const b = await open(200, "DANDELION");
    b.deps.applyFlower = async () => {
        throw new Error("boom");
    };
    await b.fake.emit(b.fake.click("confirm", OWNER));
    await b.fake.emit(b.fake.click("apply", OWNER));
    expect(text(b.fake.lastPayload())).toContain("Something went wrong applying your Flower.");
});

test("reroll: Keep outlives a slow webhook edit - idle firing mid-apply doesn't cut it off or double-apply", async () => {
    const { fake, deps, applyCalls, resultP } = await open(200, "DANDELION");
    const gate = deferred<void>();
    deps.applyFlower = async (flower) => {
        await gate.promise;
        applyCalls.push(flower);
    };
    await fake.emit(fake.click("confirm", OWNER));
    await fake.emit(fake.click("apply", OWNER));
    expect(applyCalls.length).toBe(0);

    await fake.clock.advance(settings.ui.rerollIdleMs);
    let settled = false;
    void resultP.then(() => (settled = true));
    await fake.flush();
    expect(settled).toBe(false);

    gate.resolve();
    await fake.flush();
    expect(applyCalls).toEqual(["POPPY"]);
    expect(text(fake.lastPayload())).toContain("keep your **Poppy**");
    expect(await resultP).toBeUndefined();
});

test("reroll: a slow spendSeeds on confirm outlives the idle timeout instead of timing out mid-charge", async () => {
    const { fake, deps, applyCalls, resultP } = await open(200, "DANDELION");
    const gate = deferred<{ ok: true; seeds: number } | { ok: false; seeds: number }>();
    deps.spendSeeds = () => gate.promise;
    await fake.emit(fake.click("confirm", OWNER));

    await fake.clock.advance(settings.ui.rerollIdleMs);
    gate.resolve({ ok: true, seeds: 150 });
    await fake.flush();

    expect(text(fake.lastPayload())).toContain("## Poppy");
    expect(text(fake.lastPayload())).not.toContain("timed out");

    await fake.clock.advance(settings.ui.rerollIdleMs);
    expect(await resultP).toBeUndefined();
    expect(applyCalls).toEqual(["POPPY"]);
});
