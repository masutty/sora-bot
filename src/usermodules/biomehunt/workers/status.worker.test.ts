import { describe, expect, test } from "bun:test";
import { resolveStatus, shouldAutoDelete } from "./status.worker";

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
