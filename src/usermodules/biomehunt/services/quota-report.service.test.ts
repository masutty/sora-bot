import { expect, test } from "bun:test";
import { fixedQuotaProgressWindow, quotaDayWindow } from "./quota-report.service";

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

test("fixedQuotaProgressWindow: a daily (24h) F quota counts today's quota day so far, not the last 24 hours", () => {
    // The screenshot case: 08:48 local, quota day turned at 21:00 - yesterday's 5h53m must not count.
    const now = new Date("2026-10-14T11:48:00Z");
    const today = quotaDayWindow(0, now);
    const { start, end } = fixedQuotaProgressWindow(24, today.end, now);
    expect(start.getTime()).toBe(today.start.getTime());
    expect(end).toBe(now);
});

test("fixedQuotaProgressWindow: a shorter F window ends at the quota day's end", () => {
    const now = new Date("2026-09-30T22:30:00Z");
    const { start } = fixedQuotaProgressWindow(12, quotaDayWindow(21, now).end, now);
    expect(start.toISOString()).toBe("2026-10-01T09:00:00.000Z");
});
