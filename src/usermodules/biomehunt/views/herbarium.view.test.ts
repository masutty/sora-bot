import { expect, test } from "bun:test";
import { createFakeViewTransport, type ViewPayload } from "@/define";
import { FLOWER_META, FLOWERS_BY_RARITY, FlowerRarity, RARITY_COLOR } from "../constants/flowers.constants";
import { BiomeHuntError } from "../types";
import { type HerbariumDeps, type HerbariumInput, herbariumView } from "./herbarium.view";

const OWNER = "owner";

type Json = {
    custom_id?: string;
    accent_color?: number;
    content?: string;
    options?: Array<{ label: string; value: string; description?: string }>;
    components?: Json[];
    accessory?: Json;
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

const selects = (payload: ViewPayload) => flatten(payload).filter((c) => c.options);
const accent = (payload: ViewPayload) => flatten(payload).find((c) => c.accent_color !== undefined)?.accent_color;

function fakeDeps(rerolling = false) {
    const applied: string[] = [];
    const deps: HerbariumDeps = {
        applyFlower: async (flower) => {
            applied.push(flower);
        },
        isRerolling: () => rerolling,
    };
    return { deps, applied };
}

async function open(input: Partial<HerbariumInput> = {}, ctx = fakeDeps()) {
    const fake = createFakeViewTransport();
    void fake.run(
        herbariumView(ctx.deps),
        { discordUserId: OWNER, flower: "POPPY", rows: [{ flower: "POPPY", times: 1 }], own: true, ...input },
        OWNER,
    );
    await fake.flush();
    return { fake, ...ctx };
}

const POPPY_AND_LILAC = [
    { flower: "POPPY", times: 1 },
    { flower: "LILAC", times: 2 },
];

test("herbarium: counts, ???, x N and the equipped Flower in bold", async () => {
    const { fake } = await open({
        rows: [
            { flower: "POPPY", times: 3 },
            { flower: "DANDELION", times: 1 },
        ],
    });
    const payload = fake.lastPayload();
    const t = text(payload);
    expect(t).toContain("## Herbarium");
    expect(t).toContain(`<@${OWNER}> · \`2/${Object.keys(FLOWER_META).length}\` collected`);
    expect(t).toContain(`**Common** \`2/${FLOWERS_BY_RARITY[FlowerRarity.COMMON].length}\``);
    expect(t).toContain("**Poppy** ×3");
    expect(t).toContain("Dandelion");
    expect(t).not.toContain("Dandelion ×");
    expect(t).toContain("???");
    expect(t).toContain("**Uncommon** `0/");
    expect(accent(payload)).toBe(RARITY_COLOR[FlowerRarity.COMMON]);
});

test("herbarium: rarities go from Common to RNGesus", async () => {
    const { fake } = await open();
    const t = text(fake.lastPayload());
    const order = ["Common", "Uncommon", "Rare", "Epic", "Legendary", "Mythical", "Rngesus"].map((r) => t.indexOf(`**${r}**`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
});

test("herbarium: the select lists collected Flowers except the equipped one", async () => {
    const { fake } = await open({ rows: POPPY_AND_LILAC });
    const [select] = selects(fake.lastPayload());
    expect(select.options).toEqual([{ label: "Lilac", value: "LILAC", description: "Uncommon" }]);
});

test("herbarium: someone else's Herbarium has no select", async () => {
    const { fake } = await open({ own: false, rows: POPPY_AND_LILAC });
    expect(selects(fake.lastPayload())).toHaveLength(0);
});

test("herbarium: equipping applies the Flower and re-renders with it", async () => {
    const { fake, applied } = await open({ rows: POPPY_AND_LILAC });
    await fake.emit(fake.click("equip:0", OWNER, ["LILAC"]));
    expect(applied).toEqual(["LILAC"]);
    const payload = fake.lastPayload();
    expect(text(payload)).toContain("**Lilac** ×2");
    expect(accent(payload)).toBe(RARITY_COLOR[FlowerRarity.UNCOMMON]);
    expect(selects(payload)[0].options?.map((o) => o.value)).toEqual(["POPPY"]);
});

test("herbarium: equipping is refused while a reroll is open", async () => {
    const { fake, applied } = await open({ rows: POPPY_AND_LILAC }, fakeDeps(true));
    await fake.emit(fake.click("equip:0", OWNER, ["LILAC"]));
    expect(applied).toEqual([]);
    expect(fake.notifies.at(-1)?.content).toContain("reroll");
    expect(text(fake.lastPayload())).not.toContain("**Lilac**");
});

test("herbarium: a failed apply is shown and nothing changes", async () => {
    const ctx = fakeDeps();
    ctx.deps.applyFlower = async () => {
        throw new BiomeHuntError("Couldn't access that user's macro channel.");
    };
    const { fake } = await open({ rows: POPPY_AND_LILAC }, ctx);
    await fake.emit(fake.click("equip:0", OWNER, ["LILAC"]));
    expect(fake.notifies.at(-1)?.content).toContain("macro channel");
    expect(text(fake.lastPayload())).toContain("**Poppy**");
});

test("herbarium: more than 25 collected splits into two selects", async () => {
    // The catalog is smaller than a select today, so grow it for this test only.
    const extra = Array.from({ length: 6 }, (_, i) => `TEST_COMMON_${i}`);
    for (const key of extra) {
        FLOWER_META[key] = { label: key, rarity: FlowerRarity.COMMON, file: "poppy.png" };
        FLOWERS_BY_RARITY[FlowerRarity.COMMON].push(key);
    }
    try {
        const rows = Object.keys(FLOWER_META).map((flower) => ({ flower, times: 1 }));
        expect(rows.length - 1).toBeGreaterThan(25);
        const { fake } = await open({ flower: "POPPY", rows });
        const found = selects(fake.lastPayload());
        expect(found).toHaveLength(2);
        const [low, high] = found;
        const lowRarities = ["Common", "Uncommon", "Rare"];
        expect(low.options?.every((o) => lowRarities.includes(o.description ?? ""))).toBe(true);
        expect(high.options?.every((o) => !lowRarities.includes(o.description ?? ""))).toBe(true);
        expect((low.options?.length ?? 0) + (high.options?.length ?? 0)).toBe(rows.length - 1);

        const epic = high.options?.[0].value as string;
        await fake.emit(fake.click("equip:1", OWNER, [epic]));
        expect(text(fake.lastPayload())).toContain(`**${FLOWER_META[epic].label}**`);
    } finally {
        for (const key of extra) delete FLOWER_META[key];
        FLOWERS_BY_RARITY[FlowerRarity.COMMON] = FLOWERS_BY_RARITY[FlowerRarity.COMMON].filter((k) => !extra.includes(k));
    }
});
