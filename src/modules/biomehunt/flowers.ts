import { join } from "path";

export enum FlowerRarity {
    COMMON = "common",
    UNCOMMON = "uncommon",
    RARE = "rare",
    EPIC = "epic",
    LEGENDARY = "legendary",
    MYTHICAL = "mythical",
    RNGESUS = "rngesus",
}

interface FlowerMeta {
    label: string;
    rarity: FlowerRarity;
    /** File name under src/assets/garden/, used as the macro channel webhook's avatar. */
    file: string;
}

/**
 * SINGLE SOURCE OF TRUTH for every Flower a MacroChannel can be assigned - same pattern as
 * BIOME_META/BADGE_META in types.ts. Rarity is mostly tiered by how hard the real flower is to get
 * in Minecraft (biome restriction, mob/process required); a few non-flower items (Red Mushroom,
 * Oak Sapling, Lily Pad, Golden Dandelion) are deliberately hand-picked into the higher tiers as
 * odd/joke pulls, independent of their real in-game rarity.
 */
export const FLOWER_META: Record<string, FlowerMeta> = {
    DANDELION: { label: "Dandelion", rarity: FlowerRarity.COMMON, file: "Dandelion.png" },
    POPPY: { label: "Poppy", rarity: FlowerRarity.COMMON, file: "Poppy.png" },
    OXEYE_DAISY: { label: "Oxeye Daisy", rarity: FlowerRarity.COMMON, file: "Oxeye_Daisy.png" },
    AZURE_BLUET: { label: "Azure Bluet", rarity: FlowerRarity.COMMON, file: "Azure_Bluet.png" },
    CORNFLOWER: { label: "Cornflower", rarity: FlowerRarity.COMMON, file: "Cornflower.png" },
    ORANGE_TULIP: { label: "Orange Tulip", rarity: FlowerRarity.COMMON, file: "Orange_Tulip.png" },
    PINK_TULIP: { label: "Pink Tulip", rarity: FlowerRarity.COMMON, file: "Pink_Tulip.png" },
    RED_TULIP: { label: "Red Tulip", rarity: FlowerRarity.COMMON, file: "Red_Tulip.png" },
    WHITE_TULIP: { label: "White Tulip", rarity: FlowerRarity.COMMON, file: "White_Tulip.png" },

    LILAC: { label: "Lilac", rarity: FlowerRarity.UNCOMMON, file: "Lilac.png" },
    PEONY: { label: "Peony", rarity: FlowerRarity.UNCOMMON, file: "Peony.png" },
    ROSE_BUSH: { label: "Rose Bush", rarity: FlowerRarity.UNCOMMON, file: "Rose_Bush.png" },
    SUNFLOWER: { label: "Sunflower", rarity: FlowerRarity.UNCOMMON, file: "Sunflower.png" },

    BLUE_ORCHID: { label: "Blue Orchid", rarity: FlowerRarity.RARE, file: "Blue_Orchid.png" },
    LILY_OF_THE_VALLEY: { label: "Lily of the Valley", rarity: FlowerRarity.RARE, file: "Lily_of_the_Valley.png" },
    
    TORCHFLOWER: { label: "Torchflower", rarity: FlowerRarity.EPIC, file: "Torchflower.png" },
    EYEBLOSSOM: { label: "Eyeblossom", rarity: FlowerRarity.EPIC, file: "Eyeblossom.png" },
    RED_MUSHROOM: { label: "Red Mushrooms", rarity: FlowerRarity.EPIC, file: "Red_Mushroom.png" }, // weird looking flower
    
    WITHER_ROSE: { label: "Wither Rose", rarity: FlowerRarity.LEGENDARY, file: "Wither_Rose.png" },
    OAK_SAPLING: { label: "Oak Sapling", rarity: FlowerRarity.LEGENDARY, file: "Oak_Sapling.png" }, // weird looking flower
    
    ALLIUM: { label: "Allium", rarity: FlowerRarity.MYTHICAL, file: "Allium.png" },
    LILY_PAD: { label: "Lily Pad", rarity: FlowerRarity.MYTHICAL, file: "Lily_Pad.png" }, // weird looking flower

    GOLDEN_DANDELION: { label: "Golden Dandelion", rarity: FlowerRarity.RNGESUS, file: "Golden_Dandelion.png" },
};

/**
 * Independent per-draw probability of each non-common rarity, checked in this exact order
 * (rarest first). Common has no chance of its own - it's the fallback when every other roll
 * misses, so its effective rate is whatever's left over ((1 - legendary) * (1 - epic) * ... ),
 * not a number you set directly. Use dev/scripts/calc-flower-weight.ts to see the resulting
 * odds (including common's derived rate) before tuning these.
 */
export const RARITY_CHANCE: Array<{ rarity: Exclude<FlowerRarity, FlowerRarity.COMMON>; chance: number }> = [
    { rarity: FlowerRarity.RNGESUS, chance: 0.001 / 100 },
    { rarity: FlowerRarity.MYTHICAL, chance: 0.1 / 100 },
    { rarity: FlowerRarity.LEGENDARY, chance: 3 / 100 },
    { rarity: FlowerRarity.EPIC, chance: 10 / 100 },
    { rarity: FlowerRarity.RARE, chance: 20 / 100 },
    { rarity: FlowerRarity.UNCOMMON, chance: 35 / 100 },
];

/** Keyed off FlowerRarity's own values, so adding/renaming a rarity there never needs a matching edit here. */
const FLOWERS_BY_RARITY = Object.fromEntries(Object.values(FlowerRarity).map((r) => [r, [] as string[]])) as Record<FlowerRarity, string[]>;
for (const [key, meta] of Object.entries(FLOWER_META)) {
    FLOWERS_BY_RARITY[meta.rarity].push(key);
}

/**
 * Draws a random Flower key. Rolls each rarity in RARITY_CHANCE order (rarest first); the first
 * one that hits picks uniformly among its flowers. If none hit, falls back to a common flower.
 * Independent draw every time - a Reroll can land the same Flower again on purpose (see
 * adminMemberActions.ts's reroll-flower).
 */
export function drawRandomFlower(): string {
    for (const { rarity, chance } of RARITY_CHANCE) {
        if (Math.random() < chance) {
            const pool = FLOWERS_BY_RARITY[rarity];
            return pool[Math.floor(Math.random() * pool.length)];
        }
    }
    const fallback = FLOWERS_BY_RARITY[FlowerRarity.COMMON];
    return fallback[Math.floor(Math.random() * fallback.length)];
}

/** Absolute path to a Flower's avatar image under src/assets/garden/. */
export function flowerAssetPath(key: string): string {
    const meta = FLOWER_META[key];
    if (!meta) throw new Error(`Unknown flower key: ${key}`);
    return join(__dirname, "../../assets/garden", meta.file);
}
