import { expect, test } from "bun:test";
import type { Threshold } from "../types";
import { EXAMPLE_LADDER, firedThreshold, thresholdAction, undoneBy } from "./ladder";

const ladder: Threshold[] = [
    { warns: 2, action: "mute", durationS: 60 },
    { warns: 3, action: null, durationS: null },
    { warns: 5, action: "ban", durationS: null },
];

test("a jump over several Thresholds fires only the highest one with an action", () => {
    expect(firedThreshold(ladder, 1, 3)?.warns).toBe(2);
    expect(firedThreshold(ladder, 0, 6)?.warns).toBe(5);
});

test("a later warn at the same level does not re-fire", () => {
    expect(firedThreshold(ladder, 3, 4)).toBeNull();
    expect(firedThreshold(ladder, 2, 2)).toBeNull();
});

test("crossing the next Threshold fires it", () => {
    expect(firedThreshold(ladder, 4, 6)?.action).toBe("ban");
});

test("a marker Threshold without an action never fires", () => {
    expect(firedThreshold([{ warns: 3, action: null, durationS: null }], 0, 3)).toBeNull();
    expect(firedThreshold([], 0, 10)).toBeNull();
});

test("undoneBy holds only when the weight drops below the firing level", () => {
    expect(undoneBy({ threshold_level: 3 }, 2)).toBe(true);
    expect(undoneBy({ threshold_level: 3 }, 3)).toBe(false);
    expect(undoneBy({ threshold_level: 3 }, 5)).toBe(false);
    expect(undoneBy({ threshold_level: null }, 0)).toBe(false);
});

test("the example ladder is 1 mute 1h, 2 mute 12h, 4 kick, 5 ban", () => {
    expect(EXAMPLE_LADDER).toEqual([
        { warns: 1, action: "mute", durationS: 3600 },
        { warns: 2, action: "mute", durationS: 43200 },
        { warns: 4, action: "kick", durationS: null },
        { warns: 5, action: "ban", durationS: null },
    ]);
});

test("thresholdAction titles each action", () => {
    expect(thresholdAction({ warns: 2, action: "mute", durationS: 3600 })).toBe("Mute 1h");
    expect(thresholdAction({ warns: 4, action: "kick", durationS: null })).toBe("Kick");
    expect(thresholdAction({ warns: 5, action: "ban", durationS: null })).toBe("Ban");
    expect(thresholdAction({ warns: 3, action: null, durationS: null })).toBe("No action");
});
