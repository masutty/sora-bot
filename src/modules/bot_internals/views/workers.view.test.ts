import { expect, test } from "bun:test";
import type { WorkerStats } from "@/core/worker/worker";
import { buildWorkersContainer, workerLine } from "./workers.view";

const NOW = new Date("2026-10-24T12:00:00Z").getTime();
const at = (msAgo: number) => new Date(NOW - msAgo);

const worker = (over: Partial<WorkerStats> = {}): WorkerStats => ({
    cog: "biomehunt",
    name: "status",
    intervalMs: 60_000,
    startedAt: at(600_000),
    runs: 3,
    running: false,
    lastRunAt: at(10_000),
    lastDurationMs: 42,
    lastError: null,
    skipped: 0,
    ...over,
});

test("a healthy worker shows its period, last run and duration", () => {
    expect(workerLine(worker(), true, NOW)).toBe(`✅ **status** · every 1m · <t:${(NOW - 10_000) / 1000}:R> in 42ms`);
});

test("a failing worker shows the error only when errors may be shown", () => {
    const failing = worker({ lastError: { message: "db down", at: at(5_000) } });
    expect(workerLine(failing, true, NOW)).toContain("❌ **status** · every 1m · failed <t:");
    expect(workerLine(failing, true, NOW)).toEndWith(": db down");
    expect(workerLine(failing, false, NOW)).not.toContain("db down");
});

test("running, never run, skipped and stalled states", () => {
    expect(workerLine(worker({ running: true }), true, NOW)).toBe("⏳ **status** · every 1m · running now");
    expect(workerLine(worker({ lastRunAt: null, lastDurationMs: null }), true, NOW)).toBe("⚪ **status** · every 1m · not run yet");
    expect(workerLine(worker({ skipped: 2 }), true, NOW)).toContain(" · 2 skipped");
    expect(workerLine(worker({ lastRunAt: at(200_000) }), true, NOW)).toEndWith(" ⚠️");
    expect(workerLine(worker(), true, NOW)).not.toContain("⚠️");
});

test("workers are grouped by cog", () => {
    const json = JSON.stringify(
        buildWorkersContainer([worker(), worker({ name: "vote-close" }), worker({ cog: "badgetracker", name: "poll" })], true).toJSON(),
    );
    expect(json).toContain("**biomehunt**");
    expect(json).toContain("**badgetracker**");
    expect(JSON.stringify(buildWorkersContainer([], true).toJSON())).toContain("No workers running.");
});
