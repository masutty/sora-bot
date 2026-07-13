import { monitorEventLoopDelay } from "node:perf_hooks";

// Runs for the whole process lifetime - a single rolling histogram, reset whenever read so each
// report reflects "since last checked" rather than an ever-growing all-time average.
const eventLoopHistogram = monitorEventLoopDelay({ resolution: 20 });
eventLoopHistogram.enable();

export interface EventLoopLag {
    meanMs: number;
    maxMs: number;
}

/** High lag here means the process is CPU-bound (blocked doing synchronous work) - not a DB or network symptom. */
export function getEventLoopLag(): EventLoopLag {
    const stats = { meanMs: nsToMs(eventLoopHistogram.mean), maxMs: nsToMs(eventLoopHistogram.max) };
    eventLoopHistogram.reset();
    return stats;
}

function nsToMs(ns: number): number {
    return Number.isFinite(ns) ? Math.round(ns / 1e5) / 10 : 0;
}

export interface TickStats {
    durationMs: number;
    userCount: number;
    ranAt: Date;
}

let lastTick: TickStats | null = null;

/** Called by StatusEngine after each sweep - the single most direct "is this bot keeping up" signal, since the sweep has a fixed interval it needs to finish within. */
export function recordTickStats(durationMs: number, userCount: number): void {
    lastTick = { durationMs, userCount, ranAt: new Date() };
}

export function getLastTickStats(): TickStats | null {
    return lastTick;
}
