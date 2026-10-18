import { expect, test } from "bun:test";
import { parseDuration } from "./duration";

test("parses unit suffixes, compound forms and decimals", () => {
    expect(parseDuration("6h", "h")).toBe(21600);
    expect(parseDuration("1h30m", "h")).toBe(5400);
    expect(parseDuration("90m", "h")).toBe(5400);
    expect(parseDuration("1.5", "h")).toBe(5400);
});

test("bare numbers use the default unit", () => {
    expect(parseDuration("20", "m")).toBe(1200);
});

test("surrounding spaces are ignored", () => {
    expect(parseDuration(" 2h ", "m")).toBe(7200);
});

test("returns null for invalid, zero or negative input", () => {
    expect(parseDuration("abc", "h")).toBeNull();
    expect(parseDuration("0", "h")).toBeNull();
    expect(parseDuration("-1h", "h")).toBeNull();
});
