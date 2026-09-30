import { expect, test } from "bun:test";
import { quotaDayWindow } from "./quota-report.service";

test("quotaDayWindow: after the eval hour, today's quota day started at that hour today", () => {
    const { start, end } = quotaDayWindow(21, new Date("2026-09-30T22:30:00Z"));
    expect(start.toISOString()).toBe("2026-09-30T21:00:00.000Z");
    expect(end.toISOString()).toBe("2026-10-01T21:00:00.000Z");
});

test("quotaDayWindow: before the eval hour, today's quota day started at that hour yesterday", () => {
    const { start } = quotaDayWindow(21, new Date("2026-09-30T10:00:00Z"));
    expect(start.toISOString()).toBe("2026-09-29T21:00:00.000Z");
});

test("quotaDayWindow: daysBack = 1 is the quota day right before, ending where today's starts", () => {
    const now = new Date("2026-09-30T22:30:00Z");
    const yesterday = quotaDayWindow(21, now, 1);
    expect(yesterday.start.toISOString()).toBe("2026-09-29T21:00:00.000Z");
    expect(yesterday.end.getTime()).toBe(quotaDayWindow(21, now).start.getTime());
});
