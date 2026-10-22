const URL_PATTERN = /^(?:https?:\/\/)?(?:www\.)?roblox\.com\/badges\/(\d{1,20})(?:[/?#].*)?$/i;
const ID_PATTERN = /^\d{1,20}$/;

/** Extracts a Roblox badge id from a plain id or a roblox.com badge URL. */
export function parseBadgeInput(text: string): string | null {
    const trimmed = text.trim();
    const id = ID_PATTERN.test(trimmed) ? trimmed : (URL_PATTERN.exec(trimmed)?.[1] ?? null);
    if (id === null || /^0+$/.test(id)) return null;
    return id;
}
