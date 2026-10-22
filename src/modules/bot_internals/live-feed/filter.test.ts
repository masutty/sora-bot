import { describe, expect, test } from "bun:test";
import { classifyLiveArgs, formatFilter, levelAllows, matchesFilter, parseFilter } from "./filter";

describe("matchesFilter", () => {
    test("matches on whole segments only", () => {
        const f = parseFilter("biomehunt");
        expect(matchesFilter("biomehunt", f)).toBe(true);
        expect(matchesFilter("biomehunt.services.forward", f)).toBe(true);
        expect(matchesFilter("biomehuntx", f)).toBe(false);
        expect(matchesFilter("core.botclient", f)).toBe(false);
    });

    test("exclusion wins over inclusion", () => {
        const f = parseFilter("biomehunt,-biomehunt.macro-parsers");
        expect(matchesFilter("biomehunt.macro-parsers.webhook-event", f)).toBe(false);
        expect(matchesFilter("biomehunt.workers.role", f)).toBe(true);
    });

    test("exclude-only filter keeps everything else, including null namespaces", () => {
        const f = parseFilter("-core");
        expect(matchesFilter("core.botclient", f)).toBe(false);
        expect(matchesFilter("biomehunt", f)).toBe(true);
        expect(matchesFilter(null, f)).toBe(true);
    });

    test("null namespace does not match a non-empty include list", () => {
        expect(matchesFilter(null, parseFilter("biomehunt"))).toBe(false);
    });
});

describe("parseFilter", () => {
    test("trims and drops empties", () => {
        expect(parseFilter(" a , ,-b,")).toEqual({ include: ["a"], exclude: ["b"] });
        expect(parseFilter(null)).toEqual({ include: [], exclude: [] });
    });
});

describe("levelAllows", () => {
    test("compares by verbosity", () => {
        expect(levelAllows("info", "debug")).toBe(false);
        expect(levelAllows("debug", "info")).toBe(true);
        expect(levelAllows("info", "info")).toBe(true);
    });
});

describe("classifyLiveArgs", () => {
    test("sorts arguments regardless of order", () => {
        expect(classifyLiveArgs(["biomehunt,-x", "debug", null])).toEqual({
            destination: null,
            filter: "biomehunt,-x",
            level: "debug",
        });
        expect(classifyLiveArgs(["channel", null, "warn"])).toEqual({
            destination: "channel",
            filter: null,
            level: "warn",
        });
    });
});

describe("formatFilter", () => {
    test("renders all or the rules", () => {
        expect(formatFilter(parseFilter(null))).toBe("all");
        expect(formatFilter(parseFilter("biomehunt,-biomehunt.macro-parsers"))).toBe("biomehunt, -biomehunt.macro-parsers");
    });
});
