import { formatTime } from "@/utils/format";
import type { CaseRow, Threshold } from "../types";

export const EXAMPLE_LADDER: Threshold[] = [
    { warns: 1, action: "mute", durationS: 3600 },
    { warns: 2, action: "mute", durationS: 43200 },
    { warns: 4, action: "kick", durationS: null },
    { warns: 5, action: "ban", durationS: null },
];

/**
 * The Threshold an Auto-Punishment fires for: the highest one with an action that this warn crossed
 * (`before < warns <= after`). A Threshold already at or below `before` never fires again.
 */
export function firedThreshold(ladder: Threshold[], before: number, after: number): Threshold | null {
    let fired: Threshold | null = null;
    for (const threshold of ladder) {
        if (threshold.action === null) continue;
        if (!(before < threshold.warns && threshold.warns <= after)) continue;
        if (fired === null || threshold.warns > fired.warns) fired = threshold;
    }
    return fired;
}

/** True when an unwarn dropped the active weight below the level that fired this Auto-Punishment. */
export function undoneBy(fired: Pick<CaseRow, "threshold_level">, activeWeightAfter: number): boolean {
    return fired.threshold_level !== null && activeWeightAfter < fired.threshold_level;
}

/** `2 warns: mute 12h`, `4 warns: kick`, `3 warns: none` - one Threshold in a list. */
export function thresholdLabel(threshold: Threshold): string {
    const { warns, action, durationS } = threshold;
    const what = action === null ? "none" : durationS === null ? action : `${action} ${formatTime(durationS)}`;
    return `${warns} ${warns === 1 ? "warn" : "warns"}: ${what}`;
}

/** The action of one Threshold as a title: `Mute 12h`, `Kick`, `Ban`, `No action`. */
export function thresholdAction(threshold: Threshold): string {
    const { action, durationS } = threshold;
    if (action === null) return "No action";
    const name = action.charAt(0).toUpperCase() + action.slice(1);
    return durationS === null ? name : `${name} ${formatTime(durationS)}`;
}
