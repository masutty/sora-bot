import { expect, test } from "bun:test";
import { evaluateCheck } from "./award-delta";

const I = 300_000;
const T = new Date("2026-10-22T12:00:00Z");
const ago = (ms: number) => new Date(T.getTime() - ms);

test("a missing count or check time is a baseline", () => {
    expect(evaluateCheck({ awardedCount: null, lastCheckedAt: ago(I) }, 100, T, I)).toEqual({ kind: "baseline" });
    expect(evaluateCheck({ awardedCount: 100, lastCheckedAt: null }, 100, T, I)).toEqual({ kind: "baseline" });
});

test("a gap of exactly one hour is a baseline refresh", () => {
    expect(evaluateCheck({ awardedCount: 100, lastCheckedAt: ago(3_600_000) }, 150, T, I)).toEqual({ kind: "baseline" });
});

test("equal and lower counts", () => {
    expect(evaluateCheck({ awardedCount: 100, lastCheckedAt: ago(I) }, 100, T, I)).toEqual({ kind: "unchanged" });
    expect(evaluateCheck({ awardedCount: 100, lastCheckedAt: ago(I) }, 97, T, I)).toEqual({ kind: "decreased" });
});

test("an increase within the slack posts with an interval window", () => {
    expect(evaluateCheck({ awardedCount: 100, lastCheckedAt: ago(I) }, 103, T, I)).toEqual({
        kind: "post",
        delta: 3,
        window: { kind: "interval", minutes: 5 },
    });
    expect(evaluateCheck({ awardedCount: 100, lastCheckedAt: ago(1.5 * I) }, 103, T, I)).toEqual({
        kind: "post",
        delta: 3,
        window: { kind: "interval", minutes: 5 },
    });
});

test("an increase after a longer gap posts with a since window", () => {
    expect(evaluateCheck({ awardedCount: 100, lastCheckedAt: ago(1_800_000) }, 141, T, I)).toEqual({
        kind: "post",
        delta: 41,
        window: { kind: "since", at: ago(1_800_000) },
    });
});

test("a long interval widens the silent-refresh threshold", () => {
    const H = 3_600_000;
    const prev = { awardedCount: 100, lastCheckedAt: ago(H) };
    expect(evaluateCheck(prev, 103, T, H)).toEqual({ kind: "post", delta: 3, window: { kind: "interval", minutes: 60 } });
    expect(evaluateCheck({ awardedCount: 100, lastCheckedAt: ago(5_400_001) }, 103, T, H)).toEqual({ kind: "baseline" });
});
