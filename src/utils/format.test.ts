import { expect, test } from "bun:test";
import { cut } from "./format";

test("cut keeps a short text and flattens its line breaks", () => {
    expect(cut("one\n two", 20)).toBe("one two");
});

test("cut shortens a long text to max characters with an ellipsis", () => {
    expect(cut("abcdefghij", 5)).toBe("abcd…");
});
