import { afterEach, expect, test } from "bun:test";
import { DEFAULT_BADGE_EMOJI, DELETED_BADGE, getBadgeMeta, getBiomeBadges, resolveBadgeSlug } from "../constants/badges.constants";
import {
    type BiomeEntry,
    type BiomeMeta,
    biomeAutocompleteChoices,
    buildAnsiCode,
    describeAnsiColor,
    getAllBiomes,
    isKnownBiome,
    parseAnsiCode,
    resetBiomeRegistry,
    resolveBiomeSelector,
    rewardsOnDetection,
    setBiomeRegistry,
} from "../constants/biomes.constants";
import { BiomeHuntError } from "../types";
import {
    type AnsiInput,
    addBiome,
    applyAnsiInput,
    type BiomeAdminDeps,
    editBiome,
    parseBadgeEmoji,
    parseDuration,
    parseHexColor,
    setBiomeActive,
} from "./biome-admin.service";

afterEach(() => resetBiomeRegistry());

/** An in-memory `bh_biomes` - every write lands in the registry on `reloadRegistry`, like the real one. */
function createFakeDeps(): BiomeAdminDeps & { rows: Map<string, BiomeEntry> } {
    const rows = new Map(getAllBiomes().map((e) => [e.key, e]));
    return {
        rows,
        insertBiome: async (key: string, meta: BiomeMeta) => {
            if (rows.has(key)) return false;
            rows.set(key, { ...meta, key, enabled: true });
            return true;
        },
        updateBiome: async (key: string, meta: BiomeMeta) => {
            const row = rows.get(key);
            if (row) rows.set(key, { ...meta, key, enabled: row.enabled });
        },
        setBiomeEnabled: async (key: string, enabled: boolean) => {
            const row = rows.get(key);
            if (row) rows.set(key, { ...row, enabled });
        },
        reloadRegistry: async () => setBiomeRegistry([...rows.values()]),
    };
}

const NO_ANSI: AnsiInput = { text: null, background: null, bold: null };

const NEW_BIOME = {
    name: "Blood Moon",
    detectionName: null,
    category: "event",
    color: "8b0000",
    flavorText: null,
    iconUrl: null,
    ansi: { text: "red", background: null, bold: true },
    duration: null,
    hasBadge: null,
    badgeEmoji: null,
    showInChannelName: null,
};

const NO_EDIT = {
    label: null,
    category: null,
    color: null,
    flavorText: null,
    iconUrl: null,
    ansi: NO_ANSI,
    duration: null,
    hasBadge: null,
    badgeEmoji: null,
    showInChannelName: null,
};

test("addBiome registers the normalized key, and the parser/selectors see it right away", async () => {
    const deps = createFakeDeps();
    const entry = await addBiome(NEW_BIOME, deps);

    expect(entry).toMatchObject({ key: "BLOODMOON", label: "Blood Moon", category: "event", color: 0x8b0000, ansiColor: "\u001b[1;31m" });
    expect(isKnownBiome("BLOODMOON")).toBe(true);
    expect(resolveBiomeSelector("CAT:event")).toContain("BLOODMOON");
    expect(biomeAutocompleteChoices("blood m")).toEqual([{ name: "Blood Moon", value: "BLOODMOON" }]);
});

test("addBiome takes the key from detection_name when given, so the display name can be any text", async () => {
    const deps = createFakeDeps();
    const entry = await addBiome({ ...NEW_BIOME, name: "🩸 Lua de Sangue", detectionName: "BLOOD MOON" }, deps);

    expect(entry).toMatchObject({ key: "BLOODMOON", label: "🩸 Lua de Sangue" });
});

test("without detection_name the key comes from the display name, punctuation and emoji dropped", async () => {
    const deps = createFakeDeps();
    expect(await addBiome({ ...NEW_BIOME, name: "The Null's Existence 🩸" }, deps)).toMatchObject({ key: "THENULLSEXISTENCE" });
    await expect(addBiome({ ...NEW_BIOME, name: "🩸🩸" }, deps)).rejects.toThrow("detection_name");
});

test("addBiome refuses a key that already exists, even typed differently", async () => {
    const deps = createFakeDeps();
    await expect(addBiome({ ...NEW_BIOME, name: "sand  storm" }, deps)).rejects.toThrow(BiomeHuntError);
});

test("addBiome rejects a bad color or icon before writing anything", async () => {
    const deps = createFakeDeps();
    await expect(addBiome({ ...NEW_BIOME, color: "#8b0000" }, deps)).rejects.toThrow("without `#`");
    await expect(addBiome({ ...NEW_BIOME, color: "red" }, deps)).rejects.toThrow("not a valid color");
    await expect(addBiome({ ...NEW_BIOME, iconUrl: "http://x.png" }, deps)).rejects.toThrow("https://");
    expect(deps.rows.has("BLOODMOON")).toBe(false);
});

test("editBiome changes only the given fields and 'none' clears an optional one", async () => {
    const deps = createFakeDeps();
    const entry = await editBiome({ ...NO_EDIT, biome: "HELL", color: "ff0000", flavorText: "none" }, deps);

    expect(entry).toMatchObject({ key: "HELL", label: "Hell", category: "biome", color: 0xff0000, ansiColor: "\u001b[31m" });
    expect(entry.flavorText).toBeUndefined();
    expect(entry.iconUrl).toBe("https://i.imgur.com/qf4ih2k.png");
});

test("editBiome with no field given is refused", async () => {
    const deps = createFakeDeps();
    await expect(editBiome({ ...NO_EDIT, biome: "HELL" }, deps)).rejects.toThrow("Nothing to change");
});

test("editing one ANSI part keeps the others, and clearing every part removes the color", () => {
    const glitched = "\u001b[1;32;40m";
    expect(applyAnsiInput(glitched, { ...NO_ANSI, text: "red" })).toBe("\u001b[1;31;40m");
    expect(applyAnsiInput(glitched, { ...NO_ANSI, background: "none" })).toBe("\u001b[1;32m");
    expect(applyAnsiInput(glitched, { ...NO_ANSI, bold: false })).toBe("\u001b[32;40m");
    expect(applyAnsiInput(glitched, { text: "none", background: "none", bold: false })).toBeUndefined();
    expect(() => applyAnsiInput(undefined, { ...NO_ANSI, text: "purple" })).toThrow(BiomeHuntError);
});

test("ANSI codes round-trip and read as words", () => {
    expect(parseAnsiCode("\u001b[1;37;45m")).toEqual({ bold: true, text: 37, background: 45 });
    expect(buildAnsiCode({ bold: true, text: 37, background: 45 })).toBe("\u001b[1;37;45m");
    expect(describeAnsiColor("\u001b[1;37;45m")).toBe("Bold White on Indigo");
    expect(describeAnsiColor("\u001b[36m")).toBe("Cyan");
    expect(describeAnsiColor(undefined)).toBe("None");
});

test("an admin biome gets its rewards on detection (only ever its badge - no Seeds/XP for admin), and isn't a Network biome", async () => {
    const deps = createFakeDeps();
    await addBiome({ ...NEW_BIOME, name: "Admin Storm", category: "admin" }, deps);

    expect(isKnownBiome("ADMINSTORM")).toBe(true);
    expect(rewardsOnDetection("ADMINSTORM")).toBe(true);
    expect(rewardsOnDetection("GLITCHED")).toBe(false);
    expect(rewardsOnDetection("HELL")).toBe(true);
    expect(resolveBiomeSelector("CAT:rare")).not.toContain("ADMINSTORM");
});

test("a disabled biome stops being recognized but keeps its label, and only the disabled list offers it", async () => {
    const deps = createFakeDeps();
    await setBiomeActive("HELL", false, deps);

    expect(isKnownBiome("HELL")).toBe(false);
    expect(() => resolveBiomeSelector("HELL")).toThrow(BiomeHuntError);
    expect(resolveBiomeSelector("ALL")).not.toContain("HELL");
    expect(biomeAutocompleteChoices("hell")).toEqual([]);
    expect(biomeAutocompleteChoices("hell", { which: "disabled" })).toEqual([{ name: "Hell (disabled)", value: "HELL" }]);

    await expect(setBiomeActive("HELL", false, deps)).rejects.toThrow("already disabled");
    await setBiomeActive("HELL", true, deps);
    expect(isKnownBiome("HELL")).toBe(true);
});

test("autocomplete never returns more than Discord's 25 choices", () => {
    expect(biomeAutocompleteChoices("", { selectors: true })).toHaveLength(25);
    expect(biomeAutocompleteChoices("all w", { selectors: true })).toEqual([{ name: "All Weather", value: "CAT:weather" }]);
});

test("parseHexColor only takes 6 hex digits without #", () => {
    expect(parseHexColor("FF8C00")).toBe(0xff8c00);
    expect(parseHexColor(" ff8c00 ")).toBe(0xff8c00);
    expect(() => parseHexColor("#ff8c00")).toThrow(BiomeHuntError);
    expect(() => parseHexColor("0xff8c00")).toThrow(BiomeHuntError);
    expect(() => parseHexColor("fff")).toThrow(BiomeHuntError);
});

test("parseDuration reads h/m/s combinations and refuses anything else", () => {
    expect(parseDuration("10m")).toBe(600);
    expect(parseDuration("1h30m")).toBe(5400);
    expect(parseDuration("90s")).toBe(90);
    expect(parseDuration(" 2H ")).toBe(7200);
    expect(() => parseDuration("10")).toThrow(BiomeHuntError);
    expect(() => parseDuration("0m")).toThrow(BiomeHuntError);
    expect(() => parseDuration("25h")).toThrow("24h");
});

test("a duration is set on add, changed on edit and removed with 'none'", async () => {
    const deps = createFakeDeps();
    expect(await addBiome({ ...NEW_BIOME, category: "admin", duration: "2h" }, deps)).toMatchObject({ durationS: 7200 });
    expect(await editBiome({ ...NO_EDIT, biome: "BLOODMOON", duration: "45m" }, deps)).toMatchObject({ durationS: 2700 });
    expect((await editBiome({ ...NO_EDIT, biome: "BLOODMOON", duration: "none" }, deps)).durationS).toBeUndefined();
});

test("a biome badge is turned on with its emoji, and 'none' falls back to the default emoji", async () => {
    const deps = createFakeDeps();
    expect(await addBiome({ ...NEW_BIOME, hasBadge: true, badgeEmoji: "🩸" }, deps)).toMatchObject({
        hasBadge: true,
        badgeEmoji: "🩸",
    });
    expect(getBiomeBadges()).toContain("BLOODMOON");
    expect(getBadgeMeta("BLOODMOON")).toMatchObject({ emoji: "🩸", display: "Blood Moon", description: "Found the Blood Moon biome!" });

    await editBiome({ ...NO_EDIT, biome: "BLOODMOON", badgeEmoji: "none" }, deps);
    expect(getBadgeMeta("BLOODMOON").emoji).toBe(DEFAULT_BADGE_EMOJI);

    await editBiome({ ...NO_EDIT, biome: "BLOODMOON", hasBadge: false }, deps);
    expect(getBiomeBadges()).not.toContain("BLOODMOON");
    expect(() => parseBadgeEmoji("two emojis")).toThrow(BiomeHuntError);
});

test("showing in channel names is off on add and changes only when given", async () => {
    const deps = createFakeDeps();
    expect((await addBiome(NEW_BIOME, deps)).showInChannelName).toBe(false);
    expect(await editBiome({ ...NO_EDIT, biome: "BLOODMOON", showInChannelName: true }, deps)).toMatchObject({ showInChannelName: true });
    expect(await editBiome({ ...NO_EDIT, biome: "BLOODMOON", color: "000000" }, deps)).toMatchObject({ showInChannelName: true });
});

test("the three badges that used to be hard-coded are biome badges by default", () => {
    expect(getBiomeBadges()).toEqual(["GLITCHED", "CYBERSPACE", "DREAMSPACE"]);
    expect(getBadgeMeta("GLITCHED")).toMatchObject({ slug: "glitched", emoji: "🔥", display: "Glitched" });
    expect(resolveBadgeSlug("deleted")).toBe(DELETED_BADGE);
    expect(resolveBadgeSlug("glitched")).toBe("GLITCHED");
    expect(resolveBadgeSlug("nope")).toBeNull();
});
