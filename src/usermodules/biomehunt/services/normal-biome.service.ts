import {
    formatBiomeName,
    getNormalBiome,
    isKnownBiome,
    NORMAL_BIOME,
    normalizeBiomeName,
    setNormalBiome,
} from "../constants/biomes.constants";
import { getBotSetting, setBotSetting } from "../repository/bot-settings.repository";
import { BiomeHuntError } from "../types";

const SETTING_KEY = "normal_biome";

export interface NormalBiomeStore {
    get: typeof getBotSetting;
    set: typeof setBotSetting;
}

const defaultStore: NormalBiomeStore = { get: getBotSetting, set: setBotSetting };

/** Reads the saved normal biome into memory, on boot. */
export async function loadNormalBiome(store: NormalBiomeStore = defaultStore): Promise<void> {
    setNormalBiome((await store.get(SETTING_KEY)) ?? NORMAL_BIOME);
}

/** Shows (no `input`) or changes the biome that counts as normal, for every server. Returns the message. */
export async function configureNormalBiome(input: string | null, store: NormalBiomeStore = defaultStore): Promise<string> {
    if (!input) return `The normal biome is **${formatBiomeName(getNormalBiome())}**.`;

    const biome = normalizeBiomeName(input);
    if (biome !== NORMAL_BIOME && !isKnownBiome(biome)) throw new BiomeHuntError(`\`${input}\` is not a known biome.`);

    await store.set(SETTING_KEY, biome);
    setNormalBiome(biome);
    return biome === NORMAL_BIOME
        ? `The normal biome is **${formatBiomeName(biome)}** again.`
        : `**${formatBiomeName(biome)}** is now the normal biome: it counts as macro time, not as a find.`;
}
