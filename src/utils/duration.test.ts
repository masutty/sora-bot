import { expect, test } from "bun:test";
import { parseDuration } from "./duration";

test("parses unit suffixes, compound forms and decimals", () => {
    expect(parseDuration("6h", "h")).toBe(21600);
    expect(parseDuration("1h30m", "h")).toBe(5400);
    expect(parseDuration("90m", "h")).toBe(5400);
    expect(parseDuration("1.5", "h")).toBe(5400);
    expect(parseDuration("1.5h", "h")).toBe(5400);
});

test("bare numbers use the default unit", () => {
    expect(parseDuration("20", "m")).toBe(1200);
});

test("surrounding spaces are ignored", () => {
    expect(parseDuration(" 2h ", "m")).toBe(7200);
});

test("accepts the format formatTime prints, with or without spaces between parts", () => {
    expect(parseDuration("1h 30m", "h")).toBe(5400);
    expect(parseDuration("7d", "h")).toBe(604800);
    expect(parseDuration("1d 6h", "h")).toBe(108000);
    expect(parseDuration("1d", "h")).toBe(86400);
    expect(parseDuration("45m", "h")).toBe(2700);
    expect(parseDuration("30s", "h")).toBe(30);
});

test("unit letters are case-insensitive", () => {
    expect(parseDuration("6H", "m")).toBe(21600);
});

test("returns null for invalid, zero, negative, out-of-order or empty input", () => {
    expect(parseDuration("abc", "h")).toBeNull();
    expect(parseDuration("0", "h")).toBeNull();
    expect(parseDuration("-1h", "h")).toBeNull();
    expect(parseDuration("1m30h", "h")).toBeNull();
    expect(parseDuration("", "h")).toBeNull();
});
