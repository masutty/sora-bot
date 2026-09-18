import { join } from "path";

export type FlowerRarity = "common" | "uncommon" | "rare" | "epic" | "legendary";

interface FlowerMeta {
    label: string;
    rarity: FlowerRarity;
    /** File name under src/assets/garden/, used as the macro channel webhook's avatar. */
    file: string;
}

/**
 * SINGLE SOURCE OF TRUTH for every Flower a MacroChannel can be assigned - same pattern as
 * BIOME_META/BADGE_META in types.ts. Rarity is tiered by how hard the real flower actually is to
 * get in Minecraft (biome restriction, mob/process required), except Golden Dandelion and Allium,
 * which are deliberately hand-picked as the two rarest pulls - Allium is the single rarest.
 */
export const FLOWER_META: Record<string, FlowerMeta> = {
    DANDELION: { label: "Dandelion", rarity: "common", file: "Dandelion.png" },
    POPPY: { label: "Poppy", rarity: "common", file: "Poppy.png" },
    OXEYE_DAISY: { label: "Oxeye Daisy", rarity: "common", file: "Oxeye_Daisy.png" },
    AZURE_BLUET: { label: "Azure Bluet", rarity: "common", file: "Azure_Bluet.png" },
    CORNFLOWER: { label: "Cornflower", rarity: "common", file: "Cornflower.png" },
    ORANGE_TULIP: { label: "Orange Tulip", rarity: "common", file: "Orange_Tulip.png" },
    PINK_TULIP: { label: "Pink Tulip", rarity: "common", file: "Pink_Tulip.png" },
    RED_TULIP: { label: "Red Tulip", rarity: "common", file: "Red_Tulip.png" },
    WHITE_TULIP: { label: "White Tulip", rarity: "common", file: "White_Tulip.png" },

    LILAC: { label: "Lilac", rarity: "uncommon", file: "Lilac.png" },
    PEONY: { label: "Peony", rarity: "uncommon", file: "Peony.png" },
    ROSE_BUSH: { label: "Rose Bush", rarity: "uncommon", file: "Rose_Bush.png" },
    SUNFLOWER: { label: "Sunflower", rarity: "uncommon", file: "Sunflower.png" },

    BLUE_ORCHID: { label: "Blue Orchid", rarity: "rare", file: "Blue_Orchid.png" },
    LILY_OF_THE_VALLEY: { label: "Lily of the Valley", rarity: "rare", file: "Lily_of_the_Valley.png" },
    TORCHFLOWER: { label: "Torchflower", rarity: "rare", file: "Torchflower.png" },

    GOLDEN_DANDELION: { label: "Golden Dandelion", rarity: "epic", file: "Golden_Dandelion.png" },
    WITHER_ROSE: { label: "Wither Rose", rarity: "epic", file: "Wither_Rose.png" },
    EYEBLOSSOM: { label: "Eyeblossom", rarity: "epic", file: "Eyeblossom.png" },

    ALLIUM: { label: "Allium", rarity: "legendary", file: "Allium.png" },
};

const RARITY_WEIGHT: Record<FlowerRarity, number> = {
    common: 50,
    uncommon: 27,
    rare: 13,
    epic: 7,
    legendary: 3,
};

const FLOWERS_BY_RARITY: Record<FlowerRarity, string[]> = { common: [], uncommon: [], rare: [], epic: [], legendary: [] };
for (const [key, meta] of Object.entries(FLOWER_META)) {
    FLOWERS_BY_RARITY[meta.rarity].push(key);
}

/**
 * Draws a random Flower key, weighted by rarity tier first (RARITY_WEIGHT), then uniformly among
 * the flowers within that tier. Independent draw every time - a Reroll can land the same Flower
 * again on purpose (see adminMemberActions.ts's reroll-flower).
 */
export function drawRandomFlower(): string {
    const total = Object.values(RARITY_WEIGHT).reduce((a, b) => a + b, 0);
    let roll = Math.random() * total;
    for (const rarity of Object.keys(RARITY_WEIGHT) as FlowerRarity[]) {
        roll -= RARITY_WEIGHT[rarity];
        if (roll <= 0) {
            const pool = FLOWERS_BY_RARITY[rarity];
            return pool[Math.floor(Math.random() * pool.length)];
        }
    }
    // Unreachable outside floating-point edge cases - fall back to the rarest tier rather than throw.
    const fallback = FLOWERS_BY_RARITY.legendary;
    return fallback[Math.floor(Math.random() * fallback.length)];
}

/** Absolute path to a Flower's avatar image under src/assets/garden/. */
export function flowerAssetPath(key: string): string {
    const meta = FLOWER_META[key];
    if (!meta) throw new Error(`Unknown flower key: ${key}`);
    return join(__dirname, "../../assets/garden", meta.file);
}
