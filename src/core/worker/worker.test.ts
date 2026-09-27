import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Logger } from "@/utils/logging";
import { currentTrace } from "@/utils/trace";
import type { BotClient } from "../bot-client";
import { defineWorker, startWorker, type WorkerClock } from "./worker";

const client = {} as BotClient;

let logError: ReturnType<typeof spyOn>;
let logWarn: ReturnType<typeof spyOn>;

beforeEach(() => {
    logError = spyOn(Logger.prototype, "error").mockImplementation(() => {});
    logWarn = spyOn(Logger.prototype, "warn").mockImplementation(() => {});
});

afterEach(() => {
    logError.mockRestore();
    logWarn.mockRestore();
});

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A fake `WorkerClock`: `advance(ms)` fires every due `setTimeout` (in order), settling promises between each. */
function createManualClock() {
    let now = 0;
    let nextHandle = 0;
    const timers = new Map<number, { at: number; fn: () => void }>();
    const clock: WorkerClock & { advance(ms: number): Promise<void> } = {
        setTimeout(fn, ms) {
            const handle = ++nextHandle;
            timers.set(handle, { at: now + ms, fn });
            return handle;
        },
        clearTimeout(handle) {
            timers.delete(handle as number);
        },
        async advance(ms) {
            const target = now + ms;
            for (;;) {
                const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
                if (!due) break;
                timers.delete(due[0]);
                now = due[1].at;
                due[1].fn();
                await settle();
            }
            now = target;
            await settle();
        },
    };
    return clock;
}

test("defineWorker returns the definition unchanged", () => {
    const run = async () => {};
    const def = defineWorker({ name: "sweep", intervalMs: 1_000, run });
    expect(def).toEqual({ name: "sweep", intervalMs: 1_000, run });
});

test("startWorker ticks once per intervalMs", async () => {
    const clock = createManualClock();
    let calls = 0;
    const worker = defineWorker({ name: "sweep", intervalMs: 100, run: async () => { calls++; } });
    const handle = startWorker("mycog", worker, client, clock);

    expect(calls).toBe(0);
    await clock.advance(100);
    expect(calls).toBe(1);
    await clock.advance(100);
    expect(calls).toBe(2);
    await clock.advance(250);
    expect(calls).toBe(4);

    handle.stop();
});

test("startWorker with runOnStart runs immediately, then keeps the interval", async () => {
    const clock = createManualClock();
    let calls = 0;
    const worker = defineWorker({ name: "sweep", intervalMs: 100, runOnStart: true, run: async () => { calls++; } });
    const handle = startWorker("mycog", worker, client, clock);
    await settle();

    expect(calls).toBe(1);
    await clock.advance(100);
    expect(calls).toBe(2);

    handle.stop();
});

test("a tick still running when the next is due is skipped, not queued", async () => {
    const clock = createManualClock();
    let calls = 0;
    const pending: Array<() => void> = [];
    const worker = defineWorker({
        name: "sweep",
        intervalMs: 100,
        run: () => new Promise<void>((resolve) => { calls++; pending.push(resolve); }),
    });
    const handle = startWorker("mycog", worker, client, clock);

    await clock.advance(100);
    expect(calls).toBe(1); // tick 1 started, still pending

    await clock.advance(100);
    expect(calls).toBe(1); // tick 2 was due while tick 1 was still running - skipped

    pending.shift()?.();
    await settle();

    await clock.advance(100);
    expect(calls).toBe(2); // tick 1 finished - the loop resumed normally

    handle.stop();
});

test("a run that throws is logged, and the loop keeps going", async () => {
    const clock = createManualClock();
    let calls = 0;
    const worker = defineWorker({
        name: "sweep",
        intervalMs: 100,
        run: async () => {
            calls++;
            if (calls === 1) throw new Error("boom");
        },
    });
    const handle = startWorker("mycog", worker, client, clock);

    await clock.advance(100);
    expect(calls).toBe(1);
    expect(logError).toHaveBeenCalledTimes(1);

    await clock.advance(100);
    expect(calls).toBe(2);
    expect(logError).toHaveBeenCalledTimes(1);

    handle.stop();
});

test("a run that rejects is logged the same way (non-Error rejection)", async () => {
    const clock = createManualClock();
    const worker = defineWorker({ name: "sweep", intervalMs: 100, run: async () => { throw "nope"; } });
    const handle = startWorker("mycog", worker, client, clock);

    await clock.advance(100);
    expect(logError).toHaveBeenCalledTimes(1);

    handle.stop();
});

test("a tick that runs past intervalMs warns", async () => {
    const clock = createManualClock();
    const worker = defineWorker({
        name: "sweep",
        intervalMs: 1,
        run: async () => { await new Promise((r) => setTimeout(r, 20)); },
    });
    const handle = startWorker("mycog", worker, client, clock);

    await clock.advance(1);
    await settle();
    await new Promise((r) => setTimeout(r, 30));

    expect(logWarn).toHaveBeenCalledTimes(1);
    expect((logWarn.mock.calls[0]?.[0] as string)).toContain("mycog.sweep");

    handle.stop();
});

test("stop() halts the loop - no further ticks even after more time passes", async () => {
    const clock = createManualClock();
    let calls = 0;
    const worker = defineWorker({ name: "sweep", intervalMs: 100, run: async () => { calls++; } });
    const handle = startWorker("mycog", worker, client, clock);

    await clock.advance(100);
    expect(calls).toBe(1);

    handle.stop();
    await clock.advance(300);
    expect(calls).toBe(1);
});

test("each run happens inside a trace named worker:<cog>.<name>", async () => {
    const clock = createManualClock();
    const seen: Array<{ ref?: string; command?: string } | undefined> = [];
    const worker = defineWorker({
        name: "sweep",
        intervalMs: 100,
        run: async () => { seen.push(currentTrace()); },
    });
    const handle = startWorker("mycog", worker, client, clock);

    await clock.advance(100);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.command).toBe("worker:mycog.sweep");
    expect(seen[0]?.ref).toBeTruthy();

    handle.stop();
});
