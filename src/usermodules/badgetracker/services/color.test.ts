import { expect, test } from "bun:test";
import { formatHexColor, parseHexColor } from "./color";

test("parses six-digit hex with or without #, any case", () => {
    expect(parseHexColor("#7CF5FF")).toBe(0x7cf5ff);
    expect(parseHexColor("7cf5ff")).toBe(0x7cf5ff);
    expect(parseHexColor("  #000000 ")).toBe(0);
});

test("rejects anything that isn't six hex digits", () => {
    for (const bad of ["", "#fff", "#7CF5FF0", "red", "#GGGGGG", "0x7cf5ff"]) expect(parseHexColor(bad)).toBeNull();
});

test("formats as #RRGGBB uppercase, zero-padded", () => {
    expect(formatHexColor(0x7cf5ff)).toBe("#7CF5FF");
    expect(formatHexColor(0x00ff)).toBe("#0000FF");
});
