import { describe, expect, test } from "bun:test";
import type { RoundResult } from "../services/poller.service";
import type { TrackerSettingsRow } from "../types";
import { createBackgroundRunner, createPollTick } from "./poll.worker";

function make(over: { lastRoundAt?: Date | null; intervalMinutes?: number; results?: RoundResult[] } = {}) {
    let nowMs = Date.parse("2026-10-22T12:00:00Z");
    const state: TrackerSettingsRow = { interval_minutes: over.intervalMinutes ?? 5, last_round_at: over.lastRoundAt ?? null };
    const results = [...(over.results ?? [])];
    const calls: string[] = [];
    const intervals: number[] = [];
    const tick = createPollTick({
        now: () => new Date(nowMs),
        getSettings: async () => ({ ...state }),
        setLastRoundAt: async (at) => {
            calls.push("set");
            state.last_round_at = at;
        },
        runRound: async (ms) => {
            calls.push("run");
            intervals.push(ms);
            return results.shift() ?? { kind: "done", checked: 0 };
        },
    });
    return {
        tick,
        state,
        calls,
        intervals,
        advance: (ms: number) => {
            nowMs += ms;
        },
    };
}

const limited = (retryAfterMs: number | null): RoundResult => ({ kind: "rate_limited", retryAfterMs });

describe("createPollTick", () => {
    test("runs a round when last_round_at is null", async () => {
        const t = make();
        await t.tick();
        expect(t.calls).toEqual(["set", "run"]);
    });

    test("does not run before interval_minutes have passed since last_round_at", async () => {
        const t = make({ lastRoundAt: new Date("2026-10-22T11:57:00Z") });
        await t.tick();
        expect(t.calls).toEqual([]);
        t.advance(2 * 60_000);
        await t.tick();
        expect(t.calls).toEqual(["set", "run"]);
    });

    test("sets last_round_at before running the round", async () => {
        const t = make();
        await t.tick();
        expect(t.calls[0]).toBe("set");
        expect(t.state.last_round_at?.toISOString()).toBe("2026-10-22T12:00:00.000Z");
    });

    test("passes interval_minutes * 60000 to runRound", async () => {
        const t = make({ intervalMinutes: 7 });
        await t.tick();
        expect(t.intervals).toEqual([420_000]);
    });

    test("uses the new interval on the next tick after it changes", async () => {
        const t = make({ intervalMinutes: 5 });
        await t.tick();
        t.state.interval_minutes = 2;
        t.advance(2 * 60_000);
        await t.tick();
        expect(t.intervals).toEqual([300_000, 120_000]);
    });

    test("waits retryAfterMs after a rate-limited round", async () => {
        const t = make({ intervalMinutes: 1, results: [limited(12_000)] });
        await t.tick();
        t.state.last_round_at = null; // interval gate open; only the pause blocks
        t.advance(11_999);
        await t.tick();
        expect(t.intervals.length).toBe(1);
        t.advance(1);
        await t.tick();
        expect(t.intervals.length).toBe(2);
    });

    test("backs off 30s, 60s, 120s... capped at 900s and resets after a done round", async () => {
        const waits = [30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000];
        const t = make({ intervalMinutes: 1, results: waits.map(() => limited(null)) });
        const total = () => t.intervals.length;
        for (const [i, wait] of waits.entries()) {
            t.state.last_round_at = null;
            await t.tick();
            expect(total()).toBe(i + 1);
            t.advance(wait - 1);
            await t.tick();
            expect(total()).toBe(i + 1);
            t.advance(1);
        }
        // next round returns done (default), which resets the count
        t.state.last_round_at = null;
        await t.tick();
        expect(total()).toBe(waits.length + 1);
    });

    test("restarts the backoff at 30s after a done round", async () => {
        const t = make({ intervalMinutes: 1, results: [limited(null), { kind: "done", checked: 1 }, limited(null)] });
        await t.tick();
        t.advance(30_000);
        t.state.last_round_at = null;
        await t.tick(); // done
        t.state.last_round_at = null;
        await t.tick(); // limited again
        expect(t.intervals.length).toBe(3);
        t.advance(29_999);
        t.state.last_round_at = null;
        await t.tick();
        expect(t.intervals.length).toBe(3);
        t.advance(1);
        await t.tick();
        expect(t.intervals.length).toBe(4);
    });

    test("a throwing round propagates and leaves backoff state unchanged", async () => {
        let fail = true;
        const tick = createPollTick({
            now: () => new Date("2026-10-22T12:00:00Z"),
            getSettings: async () => ({ interval_minutes: 1, last_round_at: null }),
            setLastRoundAt: async () => {},
            runRound: async () => {
                if (fail) throw new Error("boom");
                return { kind: "done", checked: 0 };
            },
        });
        await expect(tick()).rejects.toThrow("boom");
        fail = false;
        await expect(tick()).resolves.toBeUndefined();
    });
});

describe("createBackgroundRunner", () => {
    test("does not wait for the tick and skips while one is still running", async () => {
        let release: () => void = () => {};
        let started = 0;
        const run = createBackgroundRunner(
            () => {
                started++;
                return new Promise<void>((resolve) => {
                    release = resolve;
                });
            },
            () => {},
        );
        expect(run()).toBeUndefined();
        run();
        expect(started).toBe(1);
        release();
        await new Promise((r) => setTimeout(r, 0));
        run();
        expect(started).toBe(2);
    });

    test("reports a failing tick and keeps running", async () => {
        const errors: unknown[] = [];
        let calls = 0;
        const run = createBackgroundRunner(
            async () => {
                calls++;
                throw new Error("boom");
            },
            (e) => errors.push(e),
        );
        run();
        await new Promise((r) => setTimeout(r, 0));
        run();
        await new Promise((r) => setTimeout(r, 0));
        expect(calls).toBe(2);
        expect(errors.length).toBe(2);
    });
});
