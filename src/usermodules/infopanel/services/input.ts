import { UserFacingError } from "@/define";
import { settings } from "../settings";
import type { Block } from "../types";

/** A required single-line value, trimmed. */
function required(raw: string | undefined, what: string, max: number): string {
    const value = (raw ?? "").trim();
    if (!value || value.length > max) throw new UserFacingError(`The ${what} must be 1 to ${max} characters.`);
    return value;
}

export const parsePanelName = (raw: string | undefined) => required(raw, "name", settings.maxPanelName);
export const parseLabel = (raw: string | undefined) => required(raw, "label", settings.maxLabel);
export const parseTitle = (raw: string | undefined) => required(raw, "title", settings.maxTitle);

/** Blank gives the default. */
export function parsePlaceholder(raw: string | undefined): string {
    const value = (raw ?? "").trim();
    if (value.length > settings.maxPlaceholder)
        throw new UserFacingError(`The select text can have up to ${settings.maxPlaceholder} characters.`);
    return value || settings.defaultPlaceholder;
}

export function parseDescription(raw: string | undefined): string | null {
    const value = (raw ?? "").trim();
    if (value.length > settings.maxDescription)
        throw new UserFacingError(`The description can have up to ${settings.maxDescription} characters.`);
    return value || null;
}

export const parseText = (raw: string | undefined) => required(raw, "text", settings.maxTextBlock);

/** An emoji that renders as one: emoji presentation by default, or a pictograph made one with U+FE0F (so (c) and (tm) alone are refused). */
const PICTO = String.raw`(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F)`;
const UNICODE_EMOJI = new RegExp(
    String.raw`^(?:\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3|${PICTO}\p{Emoji_Modifier}?(?:\u200D${PICTO}\p{Emoji_Modifier}?)*)$`,
    "u",
);
const CUSTOM_EMOJI = /^<a?:\w{2,32}:\d{17,20}>$/;

/** A unicode emoji or a custom one pasted as `<:name:id>`. Blank means none. */
export function parseEmoji(raw: string | undefined): string | null {
    const value = (raw ?? "").trim();
    if (!value) return null;
    if (!UNICODE_EMOJI.test(value) && !CUSTOM_EMOJI.test(value)) throw new UserFacingError("That is not a single emoji.");
    return value;
}

/** An https link. */
export function parseImageUrl(raw: string | undefined): string {
    const value = (raw ?? "").trim();
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new UserFacingError("The image must be a link starting with https://.");
    }
    if (url.protocol !== "https:" || value.length > settings.maxUrl) {
        throw new UserFacingError(`The image must be an https:// link of up to ${settings.maxUrl} characters.`);
    }
    return value;
}

/** Characters the title and text blocks of a page add up to. */
export function pageChars(blocks: Block[]): number {
    return blocks.reduce((sum, b) => sum + (b.t === "title" || b.t === "text" ? b.v.length : 0), 0);
}

export const imageCount = (blocks: Block[]) => blocks.filter((b) => b.t === "img").length;

/** Why `block` can't be added (or swapped in for the block at `replacing`), or null when it fits. */
export function blockProblem(blocks: Block[], block: Block, replacing?: number): string | null {
    const rest = replacing === undefined ? blocks : blocks.filter((_, i) => i !== replacing);
    if (replacing === undefined && blocks.length >= settings.maxBlocks) return `A page holds up to ${settings.maxBlocks} blocks.`;
    if (block.t === "img" && imageCount(rest) >= settings.maxImages) return `A page holds up to ${settings.maxImages} images.`;
    if (pageChars([...rest, block]) > settings.maxPageChars) return `A page holds up to ${settings.maxPageChars} characters of text.`;
    return null;
}
