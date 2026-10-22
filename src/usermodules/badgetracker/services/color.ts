/** `#7CF5FF`, `7cf5ff` → 0x7cf5ff. Anything else → `null`. */
export function parseHexColor(text: string): number | null {
    const match = /^#?([0-9a-f]{6})$/i.exec(text.trim());
    return match ? Number.parseInt(match[1] as string, 16) : null;
}

/** 0x7cf5ff → `#7CF5FF`. */
export function formatHexColor(color: number): string {
    return `#${color.toString(16).padStart(6, "0").toUpperCase()}`;
}
