import { describe, expect, test } from "bun:test";
import winston from "winston";
import { BufferTransport, ENTRY_MAX_CHARS, LogRingBuffer } from "./log-buffer";
import { customLevels, plainFormat } from "./logging";

describe("LogRingBuffer", () => {
    test("drops the oldest entry past capacity", () => {
        const buf = new LogRingBuffer(3);
        for (const n of ["1", "2", "3", "4", "5"]) buf.push({ level: "info", namespace: null, text: n });
        expect(buf.entries().map((e) => e.text)).toEqual(["3", "4", "5"]);
    });
});

function makeLogger(buf: LogRingBuffer) {
    return winston.createLogger({
        levels: customLevels.levels,
        level: "debug",
        transports: [new BufferTransport(buf, { format: plainFormat })],
    });
}

describe("BufferTransport", () => {
    test("caps a long entry", () => {
        const buf = new LogRingBuffer(10);
        makeLogger(buf).info("x".repeat(20_000));
        const [entry] = buf.entries();
        expect(entry?.text.length).toBe(ENTRY_MAX_CHARS);
        expect(entry?.text.endsWith("…")).toBe(true);
    });

    test("caps without splitting a surrogate pair", () => {
        const buf = new LogRingBuffer(10);
        // Pad so the emoji's first half is the last code unit the cap would keep.
        const probe = new LogRingBuffer(1);
        makeLogger(probe).info("");
        const prefix = probe.entries()[0]?.text.length ?? 0;
        makeLogger(buf).info(`${"x".repeat(ENTRY_MAX_CHARS - 2 - prefix)}😀${"y".repeat(100)}`);
        const [entry] = buf.entries();
        expect(entry?.text.endsWith("…")).toBe(true);
        expect(entry?.text.slice(-2, -1)).not.toMatch(/[\uD800-\uDBFF]/);
        expect(entry?.text.length).toBeLessThanOrEqual(ENTRY_MAX_CHARS);
    });

    test("captures plain text, level and namespace", () => {
        const buf = new LogRingBuffer(10);
        makeLogger(buf).child({ namespace: "core.x" }).info("hi");
        expect(buf.entries()).toHaveLength(1);
        const [entry] = buf.entries();
        expect(entry?.level).toBe("info");
        expect(entry?.namespace).toBe("core.x");
        expect(entry?.text.endsWith("[core.x]: hi")).toBe(true);
        expect(entry?.text).not.toContain("\u001b");
    });
});
