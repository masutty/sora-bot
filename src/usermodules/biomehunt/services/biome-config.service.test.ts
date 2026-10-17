import { afterEach, expect, test } from "bun:test";
import { type BiomeEntry, getAllBiomes, resetBiomeRegistry, setBiomeRegistry } from "../constants/biomes.constants";
import { BiomeHuntError } from "../types";
import { applyBiomeImport, BIOME_CONFIG_FORMAT, buildBiomeConfig, parseBiomeConfig, planBiomeImport } from "./biome-config.service";

afterEach(() => resetBiomeRegistry());

const exportText = (entries: BiomeEntry[]) => JSON.stringify(buildBiomeConfig(entries, "Sora Dev#0001"));

/** `""` and `undefined` are the same "unset" - the seed has `iconUrl: ""` on one biome. */
const normalized = (entries: BiomeEntry[]) =>
    entries.map((e) => ({
        ...e,
        iconUrl: e.iconUrl || undefined,
        flavorText: e.flavorText || undefined,
        ansiColor: e.ansiColor || undefined,
    }));

test("export -> import round-trips every field, disabled biomes and order included", () => {
    const entries = getAllBiomes().map((e) => (e.key === "HELL" ? { ...e, enabled: false } : e));
    const parsed = parseBiomeConfig(exportText(entries));
    expect(parsed).toEqual(normalized(entries));
});

test("the file stores readable values: hex without # and ANSI as color names", () => {
    const glitched = buildBiomeConfig(getAllBiomes(), null).biomes.find((b) => b.detectionName === "GLITCHED");
    expect(glitched).toMatchObject({ color: "FF00FF", ansi: { text: "green", background: "dark-blue", bold: true }, enabled: true });
});

test("importing an identical file changes nothing", () => {
    const current = getAllBiomes();
    const plan = planBiomeImport(current, parseBiomeConfig(exportText(current)), true);
    expect(plan).toMatchObject({ added: [], updated: [], disabled: [], unchanged: current.length });
});

test("merge adds and updates the file's biomes and keeps the rest; mirror disables the rest", () => {
    const current = getAllBiomes();
    const hell = current.find((e) => e.key === "HELL") as BiomeEntry;
    const incoming: BiomeEntry[] = [
        { ...hell, color: 0xff0000, flavorText: undefined },
        { key: "BLOODMOON", label: "Blood Moon", category: "event", color: 0x8b0000, enabled: true },
    ];

    const merge = planBiomeImport(current, incoming, false);
    expect(merge.added).toEqual(["BLOODMOON"]);
    expect(merge.updated).toEqual([{ key: "HELL", fields: ["color", "flavorText"] }]);
    expect(merge.disabled).toEqual([]);
    expect(merge.result.map((e) => e.key).slice(0, 2)).toEqual(["HELL", "BLOODMOON"]);
    expect(merge.result).toHaveLength(current.length + 1);
    expect(merge.result.every((e) => e.enabled)).toBe(true);

    const mirror = planBiomeImport(current, incoming, true);
    expect(mirror.disabled).toHaveLength(current.length - 1);
    expect(mirror.result.filter((e) => e.enabled).map((e) => e.key)).toEqual(["HELL", "BLOODMOON"]);
});

test("applyBiomeImport saves the planned registry and reloads it", async () => {
    const saved: BiomeEntry[][] = [];
    const plan = planBiomeImport(
        getAllBiomes(),
        [{ key: "BLOODMOON", label: "Blood Moon", category: "event", color: 1, enabled: true }],
        false,
    );
    await applyBiomeImport(plan, {
        saveAllBiomes: async (entries) => {
            saved.push(entries);
        },
        reloadRegistry: async () => setBiomeRegistry(saved[0]),
    });
    expect(getAllBiomes()[0].key).toBe("BLOODMOON");
});

test("a file with any bad biome is refused whole, naming every bad one", () => {
    const file = buildBiomeConfig(getAllBiomes(), null);
    file.biomes[0].color = "#A9DFFF";
    file.biomes[1].category = "nope";
    file.biomes.push({ ...file.biomes[2] });

    let message = "";
    try {
        parseBiomeConfig(JSON.stringify(file));
    } catch (err) {
        expect(err).toBeInstanceOf(BiomeHuntError);
        message = (err as Error).message;
    }
    expect(message).toContain("Nothing was imported");
    expect(message).toContain("`WINDY`");
    expect(message).toContain("`SNOWY`");
    expect(message).toContain("appears twice");
});

test("a file that isn't a biome export is refused", () => {
    expect(() => parseBiomeConfig("not json")).toThrow("valid JSON");
    expect(() => parseBiomeConfig(JSON.stringify({ format: "other", version: 1, biomes: [] }))).toThrow(BIOME_CONFIG_FORMAT);
    expect(() => parseBiomeConfig(JSON.stringify({ format: BIOME_CONFIG_FORMAT, version: 99, biomes: [] }))).toThrow("version");
});
