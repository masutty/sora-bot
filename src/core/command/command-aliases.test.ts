import { describe, expect, test } from "bun:test";
import { SlashCommandBuilder } from "discord.js";
import type { CommandDefinition } from "../../types";
import { aliasCommands } from "./command-aliases";
import type { CommandArgs } from "./command-args";
import type { CommandContext } from "./command-context";
import { buildSlashJson } from "./command-dispatch";
import { buildHelpContainer } from "./command-usage";

function def(extra: Partial<CommandDefinition> = {}): CommandDefinition {
    return {
        name: "bh",
        description: "Biome hunting commands.",
        guildOnly: true,
        adminOnly: true,
        aliases: ["balance"],
        options: new SlashCommandBuilder()
            .setName("bh")
            .setDescription("Biome hunting commands.")
            .addSubcommand((s) => s.setName("setup").setDescription("Set up."))
            .addSubcommand((s) =>
                s
                    .setName("balance")
                    .setDescription("View your Seeds.")
                    .addUserOption((o) => o.setName("user").setDescription("Whose balance")),
            ),
        run: async () => {},
        ...extra,
    } as CommandDefinition;
}

describe("aliasCommands", () => {
    test("a command with no aliases adds nothing", () => {
        expect(aliasCommands(def({ aliases: undefined }))).toEqual([]);
    });

    test("an alias registers as its own top-level command with the subcommand's options", () => {
        const [alias] = aliasCommands(def());
        expect(alias.name).toBe("balance");
        expect(alias.description).toBe("View your Seeds.");
        const json = buildSlashJson(alias);
        expect(json).toMatchObject({ name: "balance", description: "View your Seeds." });
        expect((json as { options: Array<{ name: string }> }).options.map((o) => o.name)).toEqual(["user"]);
    });

    test("an alias keeps the parent's guards and stays out of the help list", () => {
        const [alias] = aliasCommands(def());
        expect(alias).toMatchObject({ guildOnly: true, adminOnly: true, showOnHelp: false });
        expect(alias.aliases).toBeUndefined();
    });

    test("an alias runs the parent's run as that subcommand", async () => {
        const seen: Array<[string | null, string | null, string | null]> = [];
        const parent = def({
            run: async (ctx: CommandContext) => {
                seen.push([ctx.args.getSubcommand(), ctx.args.getSubcommandGroup(), ctx.args.getString("x")]);
            },
        } as Partial<CommandDefinition>);
        const [alias] = aliasCommands(parent);
        const args = { getSubcommand: () => null, getSubcommandGroup: () => null, getString: () => "kept" } as unknown as CommandArgs;
        await (alias.run as (ctx: CommandContext) => Promise<void>)({ args } as CommandContext);
        expect(seen).toEqual([["balance", null, "kept"]]);
    });

    test("an alias takes its subcommand's mode", () => {
        const [alias] = aliasCommands(def({ subcommandModes: { balance: "slash" } }));
        expect(alias.modes).toBe("slash");
    });

    test("an alias that names no subcommand fails loudly", () => {
        expect(() => aliasCommands(def({ aliases: ["nope"] }))).toThrow('alias "nope" matches no subcommand');
    });

    test("a command without run can't have aliases", () => {
        expect(() => aliasCommands(def({ run: undefined, executeAsSlash: async () => {} }))).toThrow("aliases need `run`");
    });
});

test("the parent's help names the alias next to its subcommand", () => {
    const payload = JSON.stringify(buildHelpContainer("/", def(), [], false, "slash")?.toJSON());
    expect(payload).toContain("`/bh balance [user]` · `/balance` - View your Seeds.");
    expect(payload).toContain("`/bh setup` - Set up.");
});
