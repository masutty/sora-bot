import { expect, test } from "bun:test";
import { settings } from "../settings";
import type { Block } from "../types";
import { blockProblem, parseDescription, parseEmoji, parseImageUrl, parseLabel, parsePlaceholder } from "./input";

test("parseEmoji accepts unicode, flags, keycaps and custom emoji; blank means none", () => {
    for (const ok of ["📜", "🎙️", "⚖️", "👍🏽", "🇧🇷", "1️⃣", "👨‍👩‍👧", "<:rules:123456789012345678>", "<a:spin:123456789012345678>"]) {
        expect(parseEmoji(ok)).toBe(ok);
    }
    expect(parseEmoji("  ")).toBeNull();
    expect(parseEmoji(undefined)).toBeNull();
});

test("parseEmoji refuses words, two emoji and broken custom emoji", () => {
    for (const bad of ["rules", "📜📜", "<:rules:abc>", ":rules:", "a", "©", "™", "‼"]) {
        expect(() => parseEmoji(bad)).toThrow("not a single emoji");
    }
});

test("parseImageUrl takes only https links", () => {
    expect(parseImageUrl(" https://i.imgur.com/a.png ")).toBe("https://i.imgur.com/a.png");
    expect(() => parseImageUrl("http://i.imgur.com/a.png")).toThrow("https");
    expect(() => parseImageUrl("not a link")).toThrow("https");
    expect(() => parseImageUrl(`https://x.io/${"a".repeat(settings.maxUrl)}`)).toThrow("https");
});

test("single-line values are trimmed and bounded", () => {
    expect(parseLabel("  Rules ")).toBe("Rules");
    expect(() => parseLabel("   ")).toThrow("label");
    expect(() => parseLabel("x".repeat(settings.maxLabel + 1))).toThrow("label");
    expect(parseDescription("")).toBeNull();
    expect(() => parseDescription("x".repeat(settings.maxDescription + 1))).toThrow("description");
});

test("parsePlaceholder falls back to the default when blank", () => {
    expect(parsePlaceholder("  ")).toBe(settings.defaultPlaceholder);
    expect(parsePlaceholder("Pick a category")).toBe("Pick a category");
});

test("blockProblem enforces block, image and text limits", () => {
    const text = (n: number): Block => ({ t: "text", v: "x".repeat(n) });
    const full = Array.from({ length: settings.maxBlocks }, (): Block => ({ t: "sep" }));
    expect(blockProblem(full, { t: "sep" })).toContain("blocks");
    expect(blockProblem(full, { t: "sep" }, 0)).toBeNull();

    const images: Block[] = Array.from({ length: settings.maxImages }, () => ({ t: "img", url: "https://a.io/x.png" }));
    expect(blockProblem(images, { t: "img", url: "https://a.io/y.png" })).toContain("images");
    expect(blockProblem(images, { t: "img", url: "https://a.io/y.png" }, 0)).toBeNull();

    expect(blockProblem([text(settings.maxTextBlock), text(settings.maxTextBlock)], text(settings.maxTextBlock))).toContain("characters");
    expect(blockProblem([text(10)], text(10))).toBeNull();
});
