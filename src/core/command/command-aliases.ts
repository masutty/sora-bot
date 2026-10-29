import type { RESTPostAPIChatInputApplicationCommandsJSONBody } from "discord.js";
import type { CommandDefinition } from "../../types";
import type { CommandContext } from "./command-context";
import { type RawOption, SUB_COMMAND } from "./command-dispatch";

/**
 * The top-level commands a command's `aliases` declare: `/bh` with `aliases: ["balance"]` also gets
 * `/balance`, with that subcommand's options and description, running `/bh`'s own `run` (and its
 * autocomplete) exactly as `/bh balance` would - `ctx.args.getSubcommand()` is `"balance"`.
 * Throws on an alias that names no plain subcommand (groups can't be aliased), or on a command that
 * handles calls with `executeAsSlash`/`executeAsPrefix` instead of `run`.
 */
export function aliasCommands(def: CommandDefinition): CommandDefinition[] {
    if (!def.aliases?.length) return [];
    const run = def.run as ((ctx: CommandContext) => Promise<void>) | undefined;
    if (!run || def.executeAsSlash || def.executeAsPrefix) throw new Error(`/${def.name}: aliases need \`run\` and no mode overrides`);
    const json = def.options?.toJSON() as RESTPostAPIChatInputApplicationCommandsJSONBody | undefined;
    const subs = ((json?.options ?? []) as RawOption[]).filter((o) => o.type === SUB_COMMAND);

    return def.aliases.map((name): CommandDefinition => {
        const sub = subs.find((s) => s.name === name);
        if (!sub) throw new Error(`/${def.name}: alias "${name}" matches no subcommand`);
        const body = { ...json, name, description: sub.description, options: sub.options ?? [] };
        const { aliases: _aliases, subcommandModes, onMissingSubcommand: _onMissing, ...rest } = def;
        return {
            ...rest,
            name,
            description: sub.description,
            // Every reader of `options` only calls `toJSON()`: registration, prefix parsing, usage, guards.
            options: { toJSON: () => body } as unknown as CommandDefinition["options"],
            modes: subcommandModes?.[name] ?? def.modes,
            showOnHelp: false,
            run: (ctx: CommandContext) => run({ ...ctx, args: { ...ctx.args, getSubcommand: () => name, getSubcommandGroup: () => null } }),
        } as CommandDefinition;
    });
}
