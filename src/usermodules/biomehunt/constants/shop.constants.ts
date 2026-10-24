import { BiomeHuntError } from "../types";

export const PURCHASE_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const PURCHASE_CODE_LENGTH = 6;
export const MAX_SHOP_ITEMS = 25;
export const MAX_ITEM_PRICE = 1_000_000;
export const ITEM_NAME_MAX = 60;
export const ITEM_DESCRIPTION_MAX = 300;
export const DURATION_PRESET_DAYS = [1, 3, 7, 14, 30];
export const MIN_ROLE_DURATION_S = 3600;
export const MAX_ROLE_DURATION_S = 365 * 86400;
export const SHOP_ITEMS_PER_PAGE = 5;
export const PURCHASES_PER_PAGE = 10;
export const STATUS_COLORS = { pending: 0xf0b232, delivered: 0x3ba55d, refunded: 0x80848e, failed: 0xda373c };

/** A random Purchase ID from the unambiguous alphabet (no 0/O/1/I/L). */
export function generatePurchaseCode(random: () => number = Math.random): string {
    let code = "";
    for (let i = 0; i < PURCHASE_CODE_LENGTH; i++) code += PURCHASE_CODE_ALPHABET[Math.floor(random() * PURCHASE_CODE_ALPHABET.length)];
    return code;
}

/** Cleans what a member typed (`#k7q2mx `) into a code, or null when it can't be one. */
export function normalizePurchaseCode(raw: string): string | null {
    const code = raw.trim().replace(/^#/, "").trim().toUpperCase();
    if (code.length !== PURCHASE_CODE_LENGTH) return null;
    for (const ch of code) if (!PURCHASE_CODE_ALPHABET.includes(ch)) return null;
    return code;
}

export function formatPurchaseCode(code: string): string {
    return `#${code}`;
}

/** Reads `7d`, `12h`, `1d12h` or `90m` into seconds; throws when it is not a duration or is outside 1 hour - 365 days. */
export function parseRoleDuration(raw: string): number {
    const match = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/.exec(raw.trim().toLowerCase());
    if (!match || !raw.trim()) throw new BiomeHuntError(`\`${raw}\` is not a duration - use something like \`7d\`, \`12h\` or \`1d12h\`.`);
    const seconds = Number(match[1] ?? 0) * 86400 + Number(match[2] ?? 0) * 3600 + Number(match[3] ?? 0) * 60;
    if (seconds < MIN_ROLE_DURATION_S || seconds > MAX_ROLE_DURATION_S)
        throw new BiomeHuntError("A role can last from 1 hour to 365 days.");
    return seconds;
}

/** An amount as inline code with a thousands separator: `1,250 🌱`. */
export function formatSeeds(n: number): string {
    return `\`${n.toLocaleString("en-US")} 🌱\``;
}
