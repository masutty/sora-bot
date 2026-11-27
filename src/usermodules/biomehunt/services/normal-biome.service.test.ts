import { afterEach, expect, test } from "bun:test";
import { resetBiomeRegistry, setNormalBiome } from "../constants/biomes.constants";
import { inspectMessage } from "../macro-parsers";
import { configureNormalBiome, loadNormalBiome, type NormalBiomeStore } from "./normal-biome.service";

afterEach(() => {
    setNormalBiome("NORMAL");
    resetBiomeRegistry();
});

function memoryStore(): NormalBiomeStore {
    const values = new Map<string, string>();
    return {
        get: async (key) => values.get(key) ?? null,
        set: async (key, value) => void values.set(key, value),
    };
}

const read = (biome: string) => inspectMessage({ webhookId: "w", embeds: [{ title: `Biome Started - ${biome}` }] });

test("the chosen normal biome is a checkpoint instead of a find, until it is changed back", async () => {
    const store = memoryStore();
    expect(read("SNOWY").event?.biome).toBe("SNOWY");

    await configureNormalBiome("snowy", store);
    expect(read("SNOWY")).toMatchObject({ event: null, checkpoint: { kind: "normal", biome: "SNOWY" } });
    // The plain Normal biome stays a checkpoint during a season.
    expect(read("NORMAL").checkpoint?.kind).toBe("normal");

    setNormalBiome("NORMAL");
    await loadNormalBiome(store);
    expect(read("SNOWY").event).toBeNull();

    await configureNormalBiome("NORMAL", store);
    expect(read("SNOWY").event?.biome).toBe("SNOWY");
});

test("an unknown biome is refused and nothing changes", async () => {
    const store = memoryStore();
    await expect(configureNormalBiome("nope", store)).rejects.toThrow("not a known biome");
    expect(await configureNormalBiome(null, store)).toContain("**Normal**");
});
