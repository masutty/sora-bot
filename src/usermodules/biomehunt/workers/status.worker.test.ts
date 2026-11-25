import { describe, expect, test } from "bun:test";
import { resolveStatus, secondsSinceAutoDeleteClock, shouldAutoDelete } from "./status.worker";

const GAP = 1200;
const IDLE = 1800;
const INACTIVE = 86400;

describe("resolveStatus", () => {
    test("counts idle and inactive from the end of the session", () => {
        expect(resolveStatus(0, GAP, IDLE, INACTIVE)).toBe("active");
        expect(resolveStatus(GAP + IDLE - 1, GAP, IDLE, INACTIVE)).toBe("active");
        expect(resolveStatus(GAP + IDLE, GAP, IDLE, INACTIVE)).toBe("idle");
        expect(resolveStatus(GAP + INACTIVE - 1, GAP, IDLE, INACTIVE)).toBe("idle");
        expect(resolveStatus(GAP + INACTIVE, GAP, IDLE, INACTIVE)).toBe("inactive");
    });
});

describe("shouldAutoDelete", () => {
    test("waits for inactive plus the delete delay, counted from the session end", () => {
        expect(shouldAutoDelete(86400 + 3600, 86400, 3600)).toBe(false);
        expect(shouldAutoDelete(86400 + 3601, 86400, 3600)).toBe(true);
        expect(shouldAutoDelete(86400, 86400, 3600)).toBe(false);
    });
});

describe("secondsSinceAutoDeleteClock", () => {
    const now = Date.parse("2026-11-03T12:00:00Z");
    const THIRTY_DAYS = 30 * 86400;

    test("leaves the value unchanged without a clock", () => {
        expect(secondsSinceAutoDeleteClock(THIRTY_DAYS, null, now)).toBe(THIRTY_DAYS);
    });

    test("caps a long-gone session end at the clock", () => {
        expect(secondsSinceAutoDeleteClock(THIRTY_DAYS, new Date(now - 3600_000), now)).toBe(3600);
    });

    test("keeps the smaller session-end value", () => {
        expect(secondsSinceAutoDeleteClock(60, new Date(now - 3600_000), now)).toBe(60);
    });

    test("does not delete a member whose pause just ended", () => {
        const elapsed = secondsSinceAutoDeleteClock(THIRTY_DAYS, new Date(now), now);
        expect(shouldAutoDelete(elapsed, INACTIVE, 3600)).toBe(false);
    });
});
