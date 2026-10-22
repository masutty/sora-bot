import { settings } from "../settings";

export type CheckWindow = { kind: "interval"; minutes: number } | { kind: "since"; at: Date };
export type CheckOutcome =
    | { kind: "baseline" }
    | { kind: "unchanged" }
    | { kind: "decreased" }
    | { kind: "post"; delta: number; window: CheckWindow };

/** Decides what a fresh awarded count means compared with the stored one. */
export function evaluateCheck(
    prev: { awardedCount: number | null; lastCheckedAt: Date | null },
    current: number,
    now: Date,
    intervalMs: number,
): CheckOutcome {
    if (prev.awardedCount === null || prev.lastCheckedAt === null) return { kind: "baseline" };
    const gap = now.getTime() - prev.lastCheckedAt.getTime();
    // Long intervals stretch the normal gap, so the silent-refresh threshold never drops below the interval window.
    const silentGapMs = Math.max(settings.gap.maxMs, intervalMs * settings.gap.intervalSlack);
    if (gap >= silentGapMs) return { kind: "baseline" };
    if (current < prev.awardedCount) return { kind: "decreased" };
    if (current === prev.awardedCount) return { kind: "unchanged" };
    const window: CheckWindow =
        gap <= intervalMs * settings.gap.intervalSlack
            ? { kind: "interval", minutes: Math.round(intervalMs / 60_000) }
            : { kind: "since", at: prev.lastCheckedAt };
    return { kind: "post", delta: current - prev.awardedCount, window };
}
