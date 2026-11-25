import type { StickyMode } from "./types";

/** Sticky tunables - modes, delays, limits and capture behaviour. */
export const settings = {
    modes: ["all", "nobots"],
    delaysSeconds: [300, 3600, 10800, 21600, 43200, 86400],
    defaultMode: "all",
    defaultDelaySeconds: 300,
    defaultLimit: 5,
    captureTimeoutMs: 30_000,
    maxContent: 2000,
    accentColor: 0x5865f2,
} as const;

export function delayLabel(seconds: number): string {
    if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
    const hours = Math.round(seconds / 3600);
    return hours === 1 ? "1 hour" : `${hours} hours`;
}

export function modeLabel(mode: StickyMode): string {
    return mode === "nobots" ? "No bots" : "All messages";
}

/** Accepts the stored seconds (`300`) or a short form (`5m`, `1h`); undefined when it is not one of the listed delays. */
export function parseDelay(raw: string): number | undefined {
    const match = /^(\d+)([mh]?)$/i.exec(raw.trim());
    if (!match) return undefined;
    const unit = (match[2] ?? "").toLowerCase();
    const seconds = Number(match[1]) * (unit === "h" ? 3600 : unit === "m" ? 60 : 1);
    return (settings.delaysSeconds as readonly number[]).includes(seconds) ? seconds : undefined;
}

export const DELAY_HINT = "5m, 1h, 3h, 6h, 12h, 24h";
