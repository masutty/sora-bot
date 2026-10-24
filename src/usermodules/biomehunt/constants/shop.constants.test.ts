import { expect, test } from "bun:test";
import { BiomeHuntError } from "../types";
import { formatPurchaseCode, formatSeeds, generatePurchaseCode, normalizePurchaseCode, parseRoleDuration } from "./shop.constants";

test("generatePurchaseCode maps the random source onto the alphabet", () => {
    expect(generatePurchaseCode(() => 0)).toBe("AAAAAA");
    for (let i = 0; i < 200; i++) expect(generatePurchaseCode()).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
});

test("normalizePurchaseCode accepts only valid codes", () => {
    expect(normalizePurchaseCode("#k7q2mx ")).toBe("K7Q2MX");
    expect(normalizePurchaseCode("K7Q2M0")).toBeNull();
    expect(normalizePurchaseCode("K7Q2M")).toBeNull();
    expect(formatPurchaseCode("K7Q2MX")).toBe("#K7Q2MX");
});

test("parseRoleDuration reads d/h/m and enforces the range", () => {
    expect(parseRoleDuration("7d")).toBe(604800);
    expect(parseRoleDuration("1d12h")).toBe(129600);
    expect(parseRoleDuration("90m")).toBe(5400);
    expect(() => parseRoleDuration("30m")).toThrow(BiomeHuntError);
    expect(() => parseRoleDuration("366d")).toThrow("A role can last from 1 hour to 365 days.");
    expect(() => parseRoleDuration("7 days")).toThrow("`7 days` is not a duration - use something like `7d`, `12h` or `1d12h`.");
});

test("formatSeeds groups thousands inside inline code", () => {
    expect(formatSeeds(1250)).toBe("`1,250 🌱`");
});
