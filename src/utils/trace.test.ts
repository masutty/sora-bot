import { expect, test } from "bun:test";
import { currentTrace, formatTrace, newTraceRef, runWithTrace, type TraceContext } from "./trace";

test("the trace follows the async call chain and is gone outside it", async () => {
    expect(currentTrace()).toBeUndefined();
    await runWithTrace({ ref: "abc123" }, async () => {
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 1));
        expect(currentTrace()?.ref).toBe("abc123");
    });
    expect(currentTrace()).toBeUndefined();
});

test("a nested trace extends the outer one (a View click inherits its invocation)", () => {
    runWithTrace({ ref: "abc123", command: "bh balance", userId: "1" }, () => {
        runWithTrace({ ...(currentTrace() as TraceContext), step: "2:back" }, () => {
            expect(currentTrace()).toEqual({ ref: "abc123", command: "bh balance", userId: "1", step: "2:back" });
        });
    });
});

test("trace refs are short and distinct", () => {
    const ids = new Set(Array.from({ length: 1000 }, newTraceRef));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]{8}$/);
});

test("formatTrace renders only the fields that are set, in a fixed order", () => {
    expect(formatTrace({ ref: "abc123", step: "2:back", command: "bh balance", mode: "slash", userTag: "masutty", userId: "1", guildId: "9" }))
        .toBe("ref=abc123.2:back /bh balance u=masutty(1) g=9");
    expect(formatTrace({ ref: "abc123", command: "bh balance", mode: "prefix", userId: "1" })).toBe("ref=abc123 !bh balance u=1");
    expect(formatTrace(undefined)).toBe("");
});
