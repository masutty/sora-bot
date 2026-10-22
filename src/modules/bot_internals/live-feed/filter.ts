import { LOG_LEVELS, type LogLevel } from "@/utils/logging";

export interface FeedFilter {
    include: string[];
    exclude: string[];
}

export type Destination = "ephemeral" | "dm" | "channel";

const DESTINATIONS: readonly Destination[] = ["ephemeral", "dm", "channel"];

/** Parses `a,b,-c` into include/exclude namespace prefixes. Null or blank means "everything". */
export function parseFilter(raw: string | null): FeedFilter {
    const filter: FeedFilter = { include: [], exclude: [] };
    for (const part of (raw ?? "").split(",")) {
        const token = part.trim();
        if (!token) continue;
        if (token.startsWith("-")) {
            const prefix = token.slice(1).trim();
            if (prefix) filter.exclude.push(prefix);
        } else {
            filter.include.push(token);
        }
    }
    return filter;
}

function hasPrefix(namespace: string, prefix: string): boolean {
    return namespace === prefix || namespace.startsWith(`${prefix}.`);
}

/** Segment-prefix match: exclusions win, an empty include list allows everything. */
export function matchesFilter(namespace: string | null, filter: FeedFilter): boolean {
    if (namespace === null) return filter.include.length === 0;
    if (filter.exclude.some((p) => hasPrefix(namespace, p))) return false;
    return filter.include.length === 0 || filter.include.some((p) => hasPrefix(namespace, p));
}

/** True when `level` is at least as severe as the `min` threshold. */
export function levelAllows(min: LogLevel, level: LogLevel): boolean {
    return LOG_LEVELS.indexOf(level) <= LOG_LEVELS.indexOf(min);
}

/** Sorts free-order command arguments into destination, level and namespace filter. */
export function classifyLiveArgs(values: (string | null)[]): {
    destination: Destination | null;
    filter: string | null;
    level: LogLevel | null;
} {
    let destination: Destination | null = null;
    let filter: string | null = null;
    let level: LogLevel | null = null;
    for (const value of values) {
        if (value === null) continue;
        if ((DESTINATIONS as readonly string[]).includes(value)) destination = value as Destination;
        else if ((LOG_LEVELS as readonly string[]).includes(value)) level = value as LogLevel;
        else filter = value;
    }
    return { destination, filter, level };
}

export function formatFilter(filter: FeedFilter): string {
    const parts = [...filter.include, ...filter.exclude.map((p) => `-${p}`)];
    return parts.length === 0 ? "all" : parts.join(", ");
}
