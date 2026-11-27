import { describe, expect, test } from "bun:test";
import type { SlashCommandBuilder } from "discord.js";
import { prefixArgs } from "@/core/command/command-args";
import { fakeClient, fakeUser } from "@/core/command/fakes";
import { deriveSubcommandSchema, PrefixArgs } from "@/core/command/prefix-args";
import { BiomeHuntError } from "../types";
import admin, { parsePauseOptions, untilChoices } from "./admin.command";

const target = { guildId: "g1", discordUserId: "u1", byDiscordId: "admin1" };

function args(values: Record<string, string | boolean | null>) {
    const get = (name: string) => values[name] ?? null;
    return { getString: get, getBoolean: get } as unknown as Parameters<typeof parsePauseOptions>[0];
}

describe("parsePauseOptions", () => {
    test("applies the defaults", () => {
        expect(parsePauseOptions(args({ message: "hi" }), target)).toEqual({
            ...target,
            message: "hi",
            count: false,
            notify: "now",
            until: { kind: "interaction" },
            dismissable: true,
        });
    });

    test("maps a duration to a timed until", () => {
        expect(parsePauseOptions(args({ message: "hi", until: "3d" }), target).until).toEqual({ kind: "time", duration: "3d" });
    });

    test("maps session end spellings to session_end", () => {
        for (const until of ["session", "session end", "session_end", "Session-End"])
            expect(parsePauseOptions(args({ message: "hi", until }), target).until).toEqual({ kind: "session_end" });
    });

    test("maps notify, invalidation and dismissable", () => {
        const values = { message: "hi", notify: "session end", invalidate_sessions_while_paused: false, dismissable: false };
        expect(parsePauseOptions(args(values), target)).toMatchObject({ notify: "session_end", count: true, dismissable: false });
    });

    test("until suggests the presets, and a typed time first", () => {
        expect(untilChoices("").map((c) => c.value)).toEqual(["interaction", "session end", "1h", "6h", "1d", "3d"]);
        expect(untilChoices("12h")[0]).toEqual({ name: "For 12h", value: "12h" });
        expect(untilChoices("session").map((c) => c.value)).toEqual(["session end"]);
    });

    test("rejects a missing or blank message", () => {
        expect(() => parsePauseOptions(args({}), target)).toThrow(BiomeHuntError);
        expect(() => parsePauseOptions(args({ message: "   " }), target)).toThrow(BiomeHuntError);
    });

    test("rejects a message over 1000 characters", () => {
        expect(() => parsePauseOptions(args({ message: "a".repeat(1001) }), target)).toThrow(BiomeHuntError);
        expect(parsePauseOptions(args({ message: "a".repeat(1000) }), target).message).toHaveLength(1000);
    });

    test("rejects an unknown notify", () => {
        expect(() => parsePauseOptions(args({ message: "hi", notify: "later" }), target)).toThrow(BiomeHuntError);
    });
});

describe("!admin pause prefix form", () => {
    const subMap = deriveSubcommandSchema(admin.options as SlashCommandBuilder, new Set(admin.prefixNamedOnly));
    const parse = (tokens: string[]) => {
        const a = prefixArgs(
            new PrefixArgs(tokens, [], null, fakeClient({ "1234567890123456789": fakeUser("1234567890123456789") }), subMap),
        );
        return parsePauseOptions(a, target);
    };

    test("free text with spaces is the message verbatim", () => {
        const input = parse(["pause", "<@1234567890123456789>", ..."it seems you are macroing with a dead link".split(" ")]);
        expect(input).toMatchObject({
            message: "it seems you are macroing with a dead link",
            count: false,
            notify: "now",
            until: { kind: "interaction" },
        });
    });

    test("named options still work anywhere in the line", () => {
        const input = parse([
            "pause",
            "<@1234567890123456789>",
            "invalidate_sessions_while_paused:yes",
            "notify:now",
            "until:3d",
            "take",
            "a",
            "break",
        ]);
        expect(input).toMatchObject({ message: "take a break", count: false, until: { kind: "time", duration: "3d" } });
    });

    test("the duration reaches the service untouched", () => {
        expect(parse(["pause", "<@1234567890123456789>", "until:-3d", "hi"]).until).toEqual({ kind: "time", duration: "-3d" });
    });

    test("a quoted message works positionally", () => {
        expect(parse(["pause", "<@1234567890123456789>", "take a break"]).message).toBe("take a break");
    });

    test("unpause takes a user", () => {
        expect(subMap.get("unpause")?.options.map((o) => o.name)).toEqual(["user"]);
    });
});
