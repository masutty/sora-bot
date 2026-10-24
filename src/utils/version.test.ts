import { expect, test } from "bun:test";
import { getBuildInfo, parseVersionFile } from "./version";

test("reads hash, date and subject from version.txt", () => {
    expect(parseVersionFile("38069fd\n2026-10-24T10:30:00-03:00\nfeat(biomehunt): allow shop prices\n")).toEqual({
        commit: "38069fd",
        subject: "feat(biomehunt): allow shop prices",
        committedAt: new Date("2026-10-24T13:30:00Z"),
    });
});

test("a GIT_SHA-only stamp keeps the hash and nothing else", () => {
    expect(parseVersionFile("38069fd\n")).toEqual({ commit: "38069fd", subject: null, committedAt: null });
});

test("an empty or garbled stamp is an unknown commit", () => {
    expect(parseVersionFile("")).toEqual({ commit: null, subject: null, committedAt: null });
    expect(parseVersionFile("\nnot a date\n").committedAt).toBeNull();
});

test("the running build has a version and a start time in the past", () => {
    const info = getBuildInfo();
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(info.startedAt.getTime()).toBeLessThanOrEqual(Date.now());
});
