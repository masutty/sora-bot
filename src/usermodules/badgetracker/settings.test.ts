import { expect, test } from "bun:test";
import { parsePositiveInt } from "./settings";

test("parsePositiveInt accepts positive integers and falls back otherwise", () => {
    expect(parsePositiveInt("350", 200)).toBe(350);
    expect(parsePositiveInt(undefined, 200)).toBe(200);
    expect(parsePositiveInt("", 200)).toBe(200);
    expect(parsePositiveInt("abc", 200)).toBe(200);
    expect(parsePositiveInt("0", 200)).toBe(200);
    expect(parsePositiveInt("-5", 200)).toBe(200);
    expect(parsePositiveInt("1.5", 200)).toBe(200);
});
