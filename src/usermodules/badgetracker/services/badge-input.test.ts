import { expect, test } from "bun:test";
import { parseBadgeInput } from "./badge-input";

test("parseBadgeInput accepts plain ids", () => {
    expect(parseBadgeInput("2124445684")).toBe("2124445684");
    expect(parseBadgeInput("  2124445684 ")).toBe("2124445684");
});

test("parseBadgeInput accepts roblox badge urls", () => {
    expect(parseBadgeInput("https://www.roblox.com/badges/2124445684/Glitch-Hunter")).toBe("2124445684");
    expect(parseBadgeInput("roblox.com/badges/2124445684")).toBe("2124445684");
    expect(parseBadgeInput("HTTPS://WWW.ROBLOX.COM/badges/2124445684")).toBe("2124445684");
});

test("parseBadgeInput rejects invalid input", () => {
    expect(parseBadgeInput("https://evil.com/badges/1")).toBeNull();
    expect(parseBadgeInput("abc")).toBeNull();
    expect(parseBadgeInput("")).toBeNull();
    expect(parseBadgeInput("0")).toBeNull();
    expect(parseBadgeInput("1".repeat(21))).toBeNull();
});
