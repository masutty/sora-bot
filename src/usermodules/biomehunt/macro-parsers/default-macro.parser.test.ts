import { afterEach, beforeEach, expect, test } from "bun:test";
import { getAllBiomes, resetBiomeRegistry, setBiomeRegistry } from "../constants/biomes.constants";
import { DefaultMacroParser } from "./default-macro.parser";
import { JJaramParser } from "./jjaram.parser";
import { MultiscopeParser } from "./multiscope.parser";
import { isMerchantReport, parseEvent } from "./webhook-event.parser";

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

test("an apostrophe stays inside the word, so THE NULL'S EXISTENCE is never read as Null", () => {
    const text = { title: "Biome Ended - THE NULL'S EXISTENCE" };
    expect(parser.extractBiome(text)).toEqual({ biome: null, eventType: null });

    setBiomeRegistry([
        ...getAllBiomes(),
        { key: "THENULLSEXISTENCE", label: "The Null's Existence", category: "rare", color: 0, enabled: true },
    ]);
    expect(parser.extractBiome(text)).toEqual({ biome: "THENULLSEXISTENCE", eventType: "ended" });
    expect(parser.extractBiome({ title: "Biome Ended - The Null’s Existence" })).toEqual({
        biome: "THENULLSEXISTENCE",
        eventType: "ended",
    });
});

test("a known biome in the middle of an unknown name doesn't match alone", () => {
    expect(parser.extractBiome({ title: "Biome Started - The Hell Gate" })).toEqual({ biome: null, eventType: null });
    expect(new JJaramParser().extractBiome({ title: "Hell Gate Biome Started" })).toEqual({ biome: null, eventType: null });
});

test("MultiScope's name-first title is parsed from the whole webhook message", () => {
    const parse = (title: string) => parseEvent({ webhookId: "1", embeds: [{ title, footer: { text: "MultiScope | v0.9.9.1-Stable" } }] });

    expect(parse("🌀 WINDY Biome Started")).toMatchObject({ biome: "WINDY", eventType: "started", macroType: "multiscope" });
    expect(parse("🌧️ RAINY Biome Ended")).toMatchObject({ biome: "RAINY", eventType: "ended" });
    expect(parse("📊 Status Update: MultiScope Started")).toBeNull();
});

test("MultiScope still matches the anchor-first format", () => {
    expect(new MultiscopeParser().extractBiome({ title: "Biome Started - SAND STORM" })).toEqual({
        biome: "SANDSTORM",
        eventType: "started",
    });
});

test("MultiScope's name-first title with trailing text falls through to the name-first pattern", () => {
    expect(new MultiscopeParser().extractBiome({ title: "🌀 WINDY Biome Started at 9:28" })).toEqual({
        biome: "WINDY",
        eventType: "started",
    });
});

test("an unknown name still reports no biome", () => {
    expect(parser.extractBiome({ title: "Biome Started - Not A Real Biome" })).toEqual({ biome: null, eventType: null });
});

test("a Coteab merchant embed is a merchant report with no biome", () => {
    const arrival = "> ## Mari has arrived!\n> ### [Join Server](https://www.roblox.com/share?code=abc&type=Server)";
    const message = {
        webhookId: "1",
        embeds: [
            {
                description: arrival,
                footer: { text: "Coteab Macro v2.2.1" },
                thumbnail: { url: "https://i.postimg.cc/RZh2pw0j/mari.png" },
                fields: [
                    { name: "Detected Merchant Items", value: "No items detected" },
                    { name: "Detection Source", value: "LOGS" },
                ],
            },
        ],
    };
    expect(isMerchantReport(message)).toBe(true);
    expect(parseEvent(message)).toBeNull();
    // The arrival line alone is enough.
    expect(isMerchantReport({ webhookId: "1", embeds: [{ description: arrival }] })).toBe(true);
});
