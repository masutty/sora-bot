import { describe, expect, test } from "bun:test";
import { InteractionContextType, SlashCommandBuilder } from "discord.js";
import type { CommandDefinition } from "../../types";
import { buildSlashJson, effectiveMode, hasSubcommands, isAllowed, selectHandler } from "./command-dispatch";

const noop = async () => {};

function def(extra: Partial<CommandDefinition> = {}): CommandDefinition {
    return {
        name: "bot",
        description: "bot",
        options: new SlashCommandBuilder()
            .setName("bot")
            .setDescription("bot")
            .addSubcommand((s) => s.setName("status").setDescription("s"))
            .addSubcommand((s) => s.setName("db").setDescription("d"))
            .addSubcommand((s) => s.setName("run").setDescription("r"))
            .addSubcommandGroup((g) => g.setName("cog").setDescription("c").addSubcommand((s) => s.setName("reload").setDescription("r"))),
        ...extra,
    } as CommandDefinition;
}

const subNames = (json: ReturnType<typeof buildSlashJson>) => (json?.options ?? []).map((o) => o.name);

describe("selectHandler", () => {
    test("an override for the invoked mode wins over run", () => {
        expect(selectHandler(def({ run: noop, executeAsSlash: noop }), "slash")).toEqual({ kind: "override-slash" });
    });

    test("run is used when there's no override for that mode", () => {
        expect(selectHandler(def({ run: noop, executeAsSlash: noop }), "prefix")).toEqual({ kind: "run" });
    });

    test("nothing to run -> none", () => {
        expect(selectHandler(def(), "prefix")).toEqual({ kind: "none" });
    });
});

describe("modes", () => {
    const d = def({ subcommandModes: { db: "slash", run: "prefix", cog: "slash" } });

    test("a subcommand override beats the command default", () => {
        expect(effectiveMode(d, "db")).toBe("slash");
        expect(effectiveMode(d, "status")).toBe("both");
    });

    test("a group-level override applies to its subcommands", () => {
        expect(effectiveMode(d, "cog:reload")).toBe("slash");
    });

    test("a slash-only subcommand is rejected on prefix, allowed on slash", () => {
        expect(isAllowed(d, "prefix", "db")).toBe(false);
        expect(isAllowed(d, "slash", "db")).toBe(true);
    });

    test("hasSubcommands detects a subcommand-based builder", () => {
        expect(hasSubcommands(d)).toBe(true);
        expect(hasSubcommands({ name: "ping", description: "p" } as CommandDefinition)).toBe(false);
    });
});

describe("buildSlashJson", () => {
    test("a prefix-only subcommand is stripped from the registration", () => {
        expect(subNames(buildSlashJson(def({ subcommandModes: { run: "prefix" } })))).toEqual(["status", "db", "cog"]);
    });

    test("a group whose every subcommand is prefix-only disappears", () => {
        expect(subNames(buildSlashJson(def({ subcommandModes: { "cog:reload": "prefix" } })))).toEqual(["status", "db", "run"]);
    });

    test("modes 'prefix' -> never registered", () => {
        expect(buildSlashJson(def({ modes: "prefix" }))).toBeNull();
    });

    test("guildOnly restricts the slash command to guilds", () => {
        expect(buildSlashJson(def({ guildOnly: true }))?.contexts).toEqual([InteractionContextType.Guild]);
        expect(buildSlashJson(def())?.contexts).toBeUndefined();
    });

    test("a command without options still gets a registrable body", () => {
        const json = buildSlashJson({ name: "ping", description: "Pong" } as CommandDefinition);
        expect(json).toMatchObject({ name: "ping", description: "Pong" });
    });
});

describe("review fixes", () => {
    test("a subcommandModes key matching no subcommand is a registration error", () => {
        expect(() => buildSlashJson(def({ subcommandModes: { event_loop: "slash" } }))).toThrow("event_loop");
    });

    test("stripping every subcommand is a registration error, not an empty command", () => {
        expect(() => buildSlashJson(def({ subcommandModes: { status: "prefix", db: "prefix", run: "prefix", cog: "prefix" } })))
            .toThrow("no subcommands left");
    });
});
