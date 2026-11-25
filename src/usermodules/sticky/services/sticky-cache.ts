import type { StickyRow } from "../types";

const rows = new Map<string, StickyRow>();

/** In-memory copy of `sm_stickies`, keyed by channel id. Every write path keeps it in step with the database. */
export const stickyCache = {
    get(channelId: string): StickyRow | undefined {
        return rows.get(channelId);
    },
    set(row: StickyRow): void {
        rows.set(row.channel_id, row);
    },
    delete(channelId: string): void {
        rows.delete(channelId);
    },
    load(all: StickyRow[]): void {
        rows.clear();
        for (const row of all) rows.set(row.channel_id, row);
    },
    clear(): void {
        rows.clear();
    },
};
