import { expect, test } from "bun:test";
import { LOAD_RETRY_MS, loadWithRetry, MAX_LOAD_ATTEMPTS } from "./boot-load";

function harness(failures: number) {
    const waits: number[] = [];
    const errors: string[] = [];
    let calls = 0;
    const deps = {
        load: async () => {
            calls++;
            if (calls <= failures) throw new Error("db down");
        },
        sleep: async (ms: number) => void waits.push(ms),
        logError: (err: Error) => void errors.push(err.message),
        logInfo: () => {},
    };
    return { deps, waits, errors, calls: () => calls };
}

test("retries with backoff until the load succeeds", async () => {
    const h = harness(4);
    expect(await loadWithRetry(h.deps)).toBe(true);
    expect(h.calls()).toBe(5);
    expect(h.waits).toEqual([5_000, 30_000, 120_000, 300_000]);
    expect(h.errors).toHaveLength(4);
});

test("gives up after 10 attempts and says the module stays inert", async () => {
    const h = harness(Number.POSITIVE_INFINITY);
    expect(await loadWithRetry(h.deps)).toBe(false);
    expect(h.calls()).toBe(MAX_LOAD_ATTEMPTS);
    expect(h.waits).toHaveLength(MAX_LOAD_ATTEMPTS - 1);
    expect(h.waits.at(-1)).toBe(LOAD_RETRY_MS.at(-1) as number);
    expect(h.errors.at(-1)).toContain("inert until restart");
});
