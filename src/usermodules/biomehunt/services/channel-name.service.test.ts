import { afterEach, describe, expect, test } from "bun:test";
import { getAllBiomes, resetBiomeRegistry, setBiomeRegistry } from "../constants/biomes.constants";
import { initialChannelName, rareBadgeString, wantedChannelName } from "./channel-name.service";

describe("rareBadgeString", () => {
    test("writes emoji and count in registry order", () => {
        expect(
            rareBadgeString([
                { biome: "DREAMSPACE", count: 1 },
                { biome: "GLITCHED", count: 3 },
            ]),
        ).toBe("🔥3🌸1");
    });

    test("is empty when every count is 0", () => {
        expect(rareBadgeString([])).toBe("");
        expect(rareBadgeString([{ biome: "GLITCHED", count: 0 }])).toBe("");
    });
});

describe("wantedChannelName", () => {
    test("adds the badges before the base", () => {
        expect(wantedChannelName("・masutty", "", "🔥3")).toBe("🔥3・masutty");
    });

    test("replaces exactly the stored badges", () => {
        expect(wantedChannelName("🔥3・masutty", "🔥3", "🔥4🌸1")).toBe("🔥4🌸1・masutty");
    });

    test("keeps a manual base", () => {
        expect(wantedChannelName("🔥3・renamed-by-admin", "🔥3", "🔥4")).toBe("🔥4・renamed-by-admin");
        expect(wantedChannelName("admin-name", "🔥3", "🔥4")).toBe("🔥4admin-name");
    });

    test("stale stored badges never double", () => {
        expect(wantedChannelName("🔥4・x", "🔥3", "🔥4")).toBe("🔥4・x");
        expect(wantedChannelName("🔥4🌸1・x", "🔥3", "🔥4🌸1")).toBe("🔥4🌸1・x");
        expect(wantedChannelName("🔥4・x", "", "🔥5")).toBe("🔥5・x");
    });

    test("cuts the base, never the badges", () => {
        const name = wantedChannelName(`・${"a".repeat(95)}`, "", "🔥12");
        expect(name.length).toBe(100);
        expect(name.startsWith("🔥12・")).toBe(true);
    });

    test("flag off strips badges", () => {
        expect(wantedChannelName("🔥3🌸1・masutty", "🔥3🌸1", "")).toBe("・masutty");
    });
});

describe("initialChannelName", () => {
    test("new channel is created with badges", async () => {
        const deps = { getCounts: async () => new Map([[7, [{ biome: "GLITCHED", count: 2 }]]]) };
        expect(await initialChannelName(true, 7, "masutty", deps)).toEqual({ name: "🔥2・masutty", badges: "🔥2" });
    });

    test("flag off keeps today's name", async () => {
        const deps = { getCounts: async () => new Map([[7, [{ biome: "GLITCHED", count: 2 }]]]) };
        expect(await initialChannelName(false, 7, "masutty", deps)).toEqual({ name: "・masutty", badges: "" });
    });

    test("a failed lookup falls back to the plain name", async () => {
        const deps = {
            getCounts: async () => {
                throw new Error("db down");
            },
        };
        expect(await initialChannelName(true, 7, "masutty", deps)).toEqual({ name: "・masutty", badges: "" });
    });
});

describe("custom badge emoji", () => {
    afterEach(() => resetBiomeRegistry());

    test("a custom emoji falls back to the default in the name and the strip list", () => {
        setBiomeRegistry(getAllBiomes().map((b) => (b.key === "GLITCHED" ? { ...b, badgeEmoji: "<:glitch:123456>" } : b)));
        expect(rareBadgeString([{ biome: "GLITCHED", count: 2 }])).toBe("🏅2");
        expect(wantedChannelName("🏅2・x", "", "🏅3")).toBe("🏅3・x");
    });
});
