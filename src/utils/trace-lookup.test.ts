import { describe, expect, test } from "bun:test";
import { findTraceLines, normalizeTraceId, readTraceFacts, sanitizePaths, type TraceSources } from "./trace-lookup";

const line = (time: string, ref: string, msg: string) => `2026-11-25 ${time} info    [x] (ref=${ref} /bh balance): ${msg}`;

function sources(files: Record<string, string[]>, buffer: string[] = []): TraceSources {
    return {
        bufferLines: () => buffer,
        logFiles: async () => Object.keys(files),
        async *readLines(file) {
            yield* files[file];
        },
    };
}

test("normalizeTraceId strips backticks and spaces", () => {
    expect(normalizeTraceId(" `k3f9a2x1` ")).toBe("k3f9a2x1");
});

test("finds lines from the buffer and files, sorted and deduped", async () => {
    const a = line("10:00:00", "k3f9a2x1", "start");
    const b = line("10:00:05", "k3f9a2x1", "end");
    const found = await findTraceLines(
        "k3f9a2x1",
        sources({ f1: [a, line("10:00:01", "other", "x"), b] }, [b, line("10:00:03", "k3f9a2x1", "mid")]),
    );
    expect(found.map((l) => l.split(": ")[1])).toEqual(["start", "mid", "end"]);
});

test("matches step refs but not longer ids", async () => {
    const step = line("10:00:00", "k3f9a2x1.2:back", "click");
    const longer = line("10:00:01", "k3f9a2x1z", "no");
    expect(await findTraceLines("k3f9a2x1", sources({ f1: [step, longer] }))).toEqual([step]);
});

test("returns nothing for an unknown id", async () => {
    expect(await findTraceLines("zzzzzzzz", sources({ f1: [line("10:00:00", "k3f9a2x1", "a")] }))).toEqual([]);
});

test("stops at the first older file without the id once found", async () => {
    const read: string[] = [];
    const src = sources({ new: [line("10:00:00", "abc", "a")], mid: ["nothing"], old: [line("09:00:00", "abc", "b")] });
    const spy: TraceSources = {
        ...src,
        async *readLines(f) {
            read.push(f);
            yield* src.readLines(f);
        },
    };
    expect(await findTraceLines("abc", spy)).toHaveLength(1);
    expect(read).toEqual(["new", "mid"]);
});

test("keeps the stack lines under a matching entry, not the next entry", async () => {
    const err = line("10:00:00", "abc", "boom");
    const stack = ["Error: boom", "    at a (a.ts:1:1)", "    at b (b.ts:2:2)"];
    const next = line("10:00:01", "other", "unrelated");
    const found = await findTraceLines("abc", sources({ f1: [err, ...stack, next] }, [[err, ...stack].join("\n")]));
    expect(found).toEqual([err, ...stack]);
});

describe("sanitizePaths", () => {
    const win = { root: "C:\\Users\\bob\\proj", home: "C:\\Users\\bob" };
    const posix = { root: "/home/bob/proj", home: "/home/bob" };

    test("replaces a Windows root in both slash forms, ignoring case, before the home", () => {
        expect(sanitizePaths("at f (C:\\Users\\bob\\proj\\src\\a.ts:1:2)", win, true)).toBe("at f (.\\src\\a.ts:1:2)");
        expect(sanitizePaths("at f (c:/users/BOB/proj/src/a.ts:1:2)", win, true)).toBe("at f (./src/a.ts:1:2)");
        expect(sanitizePaths("C:\\Users\\bob\\.bun\\x.js", win, true)).toBe("~\\.bun\\x.js");
    });

    test("replaces a POSIX root and home, case-sensitive, and leaves longer names alone", () => {
        expect(sanitizePaths("at f (/home/bob/proj/src/a.ts:1:2)", posix, false)).toBe("at f (./src/a.ts:1:2)");
        expect(sanitizePaths("/home/bob/.cache/y", posix, false)).toBe("~/.cache/y");
        expect(sanitizePaths("/HOME/bob/proj/a.ts", posix, false)).toBe("/HOME/bob/proj/a.ts");
        expect(sanitizePaths("/home/bob/project2/a.ts", posix, false)).toBe("~/project2/a.ts");
    });

    test("findTraceLines sanitizes every returned line", async () => {
        const entry = ["2026-11-25 10:00:00 error [ns] (ref=zz1): boom", "    at f (/home/bob/proj/src/a.ts:1:2)"];
        const found = await findTraceLines("zz1", sources({ f1: entry }), posix);
        expect(found[1]).toBe("    at f (./src/a.ts:1:2)");
    });
});

describe("readTraceFacts", () => {
    const row = (msg: string, ref = "abc !warn u=me(1) g=2") => `2026-11-25 10:00:00 info    [core.commands] (ref=${ref}): ${msg}`;

    test("reads the header, the arguments and the outcome", () => {
        const facts = readTraceFacts([row("invoked with user=`<@1>` reason=`a b=c`"), row("ok in 12ms")]);
        expect(facts).toMatchObject({
            command: "!warn",
            userId: "1",
            userTag: "me",
            guildId: "2",
            args: "user=<@1>, reason=a b=c",
            outcome: "ok",
            tookMs: 12,
        });
    });

    test("tells the three outcomes apart and keeps a user error message", () => {
        expect(readTraceFacts([row("error in 7ms")])).toMatchObject({ outcome: "error", tookMs: 7, userError: null });
        const user = readTraceFacts([row("user-error in 3ms: Nope. (args: user=`1`)")]);
        expect(user).toMatchObject({ outcome: "user-error", userError: "Nope." });
    });

    test("leaves out what the log lacks", () => {
        const facts = readTraceFacts([row("invoked with no arguments", "abc")]);
        expect(facts).toMatchObject({ command: null, userId: null, guildId: null, args: "", outcome: null, tookMs: null });
        expect(readTraceFacts([row("hello")]).args).toBeNull();
        // An older log wrote a bare "invoked": the arguments are unknown, not empty.
        expect(readTraceFacts([row("invoked")]).args).toBeNull();
    });
});
