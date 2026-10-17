import { afterEach, beforeEach, expect, test } from "bun:test";
import { getAllBiomes, resetBiomeRegistry, setBiomeRegistry } from "../constants/biomes.constants";
import { DefaultMacroParser } from "./default-macro.parser";
import { JJaramParser } from "./jjaram.parser";

const parser = new DefaultMacroParser("test");

beforeEach(() => {
    setBiomeRegistry([
        ...getAllBiomes(),
        { key: "THERADIANTFOREST", label: "The Radiant Forest", category: "rare", color: 0xbc47ff, enabled: true },
    ]);
});
afterEach(() => resetBiomeRegistry());

test("a one-word biome still matches, with trailing text after it", () => {
    expect(parser.extractBiome({ description: "Biome Started - SINGULARITY Join Server" })).toEqual({
        biome: "SINGULARITY",
        eventType: "started",
    });
});

test("a two-word biome reported with a space matches its space-less key", () => {
    expect(parser.extractBiome({ title: "Biome Ended - SAND STORM" })).toEqual({ biome: "SANDSTORM", eventType: "ended" });
});

test("a three-word biome matches, with or without trailing text", () => {
    expect(parser.extractBiome({ title: "Biome Started - The Radiant Forest" })).toEqual({
        biome: "THERADIANTFOREST",
        eventType: "started",
    });
    expect(parser.extractBiome({ description: "**Biome Started** - THE RADIANT FOREST Join Server" })).toEqual({
        biome: "THERADIANTFOREST",
        eventType: "started",
    });
});

test("J.Jaram's name-first format matches a three-word biome, even with words before it", () => {
    const jjaram = new JJaramParser();
    expect(jjaram.extractBiome({ title: "The Radiant Forest Biome Started" })).toEqual({ biome: "THERADIANTFOREST", eventType: "started" });
    expect(jjaram.extractBiome({ title: "[Macro] Sand Storm Biome Ended" })).toEqual({ biome: "SANDSTORM", eventType: "ended" });
});

test("an unknown name still reports no biome", () => {
    expect(parser.extractBiome({ title: "Biome Started - Not A Real Biome" })).toEqual({ biome: null, eventType: null });
});
