import { expect, test } from "bun:test";
import { CASE_ID_ALPHABET, newCaseId, normalizeCaseId } from "./case-id";

test("newCaseId is 7 characters from the ambiguity-free alphabet", () => {
    for (let i = 0; i < 200; i++) {
        const id = newCaseId();
        expect(id).toHaveLength(7);
        for (const char of id) expect(CASE_ID_ALPHABET).toContain(char);
    }
    expect(CASE_ID_ALPHABET).not.toMatch(/[01OIL]/);
});

test("newCaseId uses the injected random source and survives random() = 1", () => {
    expect(newCaseId(() => 0)).toBe("AAAAAAA");
    expect(newCaseId(() => 1)).toBe("9999999");
});

test("normalizeCaseId uppercases and trims valid input", () => {
    expect(normalizeCaseId(" k7xq2mp ")).toBe("K7XQ2MP");
});

test("normalizeCaseId rejects wrong length and forbidden characters", () => {
    expect(normalizeCaseId("K7XQ2M")).toBeNull();
    expect(normalizeCaseId("K7XQ2MPP")).toBeNull();
    expect(normalizeCaseId("K7XQ2M0")).toBeNull();
    expect(normalizeCaseId("K7XQ2ML")).toBeNull();
    expect(normalizeCaseId("")).toBeNull();
});
