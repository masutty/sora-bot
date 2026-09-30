import { describe, expect, test } from "bun:test";
import { findCommandConflicts, findConflictsWithLoaded, partitionByConflicts } from "./command-conflicts";

const cog = (name: string, ...commands: string[]) => ({ name, commands: commands.map((c) => ({ name: c })) });

describe("findCommandConflicts", () => {
    test("returns nothing when every command name is unique", () => {
        expect(findCommandConflicts([cog("a", "ping", "echo"), cog("b", "profile")])).toEqual([]);
    });

    test("flags a name declared by two cogs", () => {
        expect(findCommandConflicts([cog("a", "profile"), cog("b", "profile", "balance")])).toEqual([
            { command: "profile", cogs: ["a", "b"] },
        ]);
    });

    test("compares names case-insensitively", () => {
        expect(findCommandConflicts([cog("a", "Profile"), cog("b", "profile")])).toEqual([{ command: "profile", cogs: ["a", "b"] }]);
    });

    test("flags a name declared twice inside the same cog", () => {
        expect(findCommandConflicts([cog("a", "ping", "ping")])).toEqual([{ command: "ping", cogs: ["a", "a"] }]);
    });

    test("a cog with no commands never conflicts", () => {
        expect(findCommandConflicts([{ name: "a" }, cog("b", "ping")])).toEqual([]);
    });
});

describe("partitionByConflicts", () => {
    test("rejects every cog involved in a conflict and keeps the rest", () => {
        const { accepted, rejected } = partitionByConflicts([cog("a", "profile"), cog("b", "profile"), cog("c", "ping")]);
        expect(accepted.map((c) => c.name)).toEqual(["c"]);
        expect(rejected).toEqual([
            { cog: "a", conflicts: [{ command: "profile", cogs: ["a", "b"] }] },
            { cog: "b", conflicts: [{ command: "profile", cogs: ["a", "b"] }] },
        ]);
    });

    test("accepts everything when there are no conflicts", () => {
        const { accepted, rejected } = partitionByConflicts([cog("a", "x"), cog("b", "y")]);
        expect(accepted.map((c) => c.name)).toEqual(["a", "b"]);
        expect(rejected).toEqual([]);
    });
});

describe("findConflictsWithLoaded", () => {
    test("lists the incoming cog's commands already owned by another loaded cog", () => {
        expect(findConflictsWithLoaded(cog("new", "profile", "fresh"), [cog("old", "Profile"), cog("x", "ping")])).toEqual([
            { command: "profile", cogs: ["old", "new"] },
        ]);
    });

    test("ignores a loaded cog with the same name (it is being replaced)", () => {
        expect(findConflictsWithLoaded(cog("same", "profile"), [cog("same", "profile")])).toEqual([]);
    });

    test("still catches a duplicate inside the incoming cog itself", () => {
        expect(findConflictsWithLoaded(cog("new", "ping", "ping"), [])).toEqual([{ command: "ping", cogs: ["new", "new"] }]);
    });
});
