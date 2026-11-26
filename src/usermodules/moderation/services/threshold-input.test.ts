import { expect, test } from "bun:test";
import { parseThreshold, withThreshold } from "./threshold-input";

const input = (warns: string, action: string, duration = "") => ({ warns, action, duration });

test("parses each action", () => {
    expect(parseThreshold(input("2", "mute", "12h"))).toEqual({ warns: 2, action: "mute", durationS: 43200 });
    expect(parseThreshold(input("4", "KICK", "7d"))).toEqual({ warns: 4, action: "kick", durationS: null });
    expect(parseThreshold(input("5", "ban"))).toEqual({ warns: 5, action: "ban", durationS: null });
    expect(parseThreshold(input("5", "ban", "7d"))).toEqual({ warns: 5, action: "ban", durationS: 604800 });
    expect(parseThreshold(input("3", ""))).toEqual({ warns: 3, action: null, durationS: null });
});

test("refuses a bad count, action and duration, and a mute without one", () => {
    expect(() => parseThreshold(input("0", "ban"))).toThrow(/whole number/);
    expect(() => parseThreshold(input("x", "ban"))).toThrow(/whole number/);
    expect(() => parseThreshold(input("2", "timeout"))).toThrow(/none, mute, kick or ban/);
    expect(() => parseThreshold(input("2", "mute"))).toThrow(/needs a duration/);
    expect(() => parseThreshold(input("2", "mute", "5"))).toThrow(/unit/);
    expect(() => parseThreshold(input("2", "mute", "30d"))).toThrow(/28 days/);
});

test("withThreshold sorts, refuses a duplicate count and allows editing in place", () => {
    const ladder = [
        { warns: 1, action: null, durationS: null },
        { warns: 3, action: "kick" as const, durationS: null },
    ];
    const added = withThreshold(ladder, { warns: 2, action: null, durationS: null }, null);
    expect(added.map((t) => t.warns)).toEqual([1, 2, 3]);
    expect(() => withThreshold(ladder, { warns: 3, action: null, durationS: null }, null)).toThrow(/already/);
    expect(withThreshold(ladder, { warns: 3, action: "ban", durationS: null }, 3)[1]?.action).toBe("ban");
    expect(withThreshold(ladder, { warns: 4, action: "ban", durationS: null }, 3).map((t) => t.warns)).toEqual([1, 4]);
});

test("a duration with trailing text is refused", () => {
    expect(() => parseThreshold(input("2", "mute", "30m please"))).toThrow(/unit/);
    expect(() => parseThreshold(input("2", "ban", "7d x"))).toThrow(/unit/);
});

test("a ban lasts a year at most", () => {
    expect(() => parseThreshold(input("2", "ban", "366d"))).toThrow(/365 days/);
});
