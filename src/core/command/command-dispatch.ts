import { InteractionContextType, type RESTPostAPIChatInputApplicationCommandsJSONBody, SlashCommandBuilder } from "discord.js";
import type { CommandDefinition, CommandModes } from "../../types";
import type { CommandMode } from "./command-context";

// Pure decisions the command handler makes before calling anything - kept here, free of
// discord.js I/O, so every rule is unit-tested (command-dispatch.test.ts).

export const SUB_COMMAND = 1;
export const SUB_COMMAND_GROUP = 2;

/** The slice of an option's JSON shape the framework reads. */
export interface RawOption {
    name: string;
    description: string;
    type: number;
    required?: boolean;
    options?: RawOption[];
}

/** `"sub"` or `"group:sub"` - the key format used by `subcommandModes`. `null` when not in a subcommand. */
export function subcommandKey(group: string | null, sub: string | null): string | null {
    if (!sub) return null;
    return group ? `${group}:${sub}` : sub;
}

/** Most specific wins: `"group:sub"`, then `"group"`, then the command's `modes`, then "both". */
export function effectiveMode(def: CommandDefinition, key: string | null): CommandModes {
    const overrides = def.subcommandModes ?? {};
    if (key) {
        if (overrides[key]) return overrides[key];
        const group = key.includes(":") ? key.split(":")[0] : null;
        if (group && overrides[group]) return overrides[group];
    }
    return def.modes ?? "both";
}

export function isAllowed(def: CommandDefinition, mode: CommandMode, key: string | null): boolean {
    const m = effectiveMode(def, key);
    return m === "both" || m === mode;
}

export type SelectedHandler = { kind: "override-slash" } | { kind: "override-prefix" } | { kind: "run" } | { kind: "none" };

/** A mode-specific override (`executeAsSlash`/`executeAsPrefix`) beats `run` in that mode only. */
export function selectHandler(def: CommandDefinition, mode: CommandMode): SelectedHandler {
    if (mode === "slash" && def.executeAsSlash) return { kind: "override-slash" };
    if (mode === "prefix" && def.executeAsPrefix) return { kind: "override-prefix" };
    if (def.run) return { kind: "run" };
    return { kind: "none" };
}

function topLevelOptions(def: CommandDefinition): RawOption[] {
    const json = def.options?.toJSON() as { options?: RawOption[] } | undefined;
    return json?.options ?? [];
}

export function hasSubcommands(def: CommandDefinition): boolean {
    return topLevelOptions(def).some((o) => o.type === SUB_COMMAND || o.type === SUB_COMMAND_GROUP);
}

/** The command's top-level options with every subcommand not available in `mode` removed (and groups left empty by that). */
export function optionsForMode(def: CommandDefinition, options: RawOption[], mode: CommandMode): RawOption[] {
    return options.flatMap((opt): RawOption[] => {
        if (opt.type === SUB_COMMAND) return isAllowed(def, mode, opt.name) ? [opt] : [];
        if (opt.type === SUB_COMMAND_GROUP) {
            const subs = (opt.options ?? []).filter((s) => isAllowed(def, mode, subcommandKey(opt.name, s.name)));
            return subs.length ? [{ ...opt, options: subs }] : [];
        }
        return [opt];
    });
}

/**
 * The exact body registered with Discord - `registerSlashCommands` AND `scripts/check-commands.ts`
 * both use this, so the pre-deploy check validates what actually gets registered. `null` = the
 * command is prefix-only and isn't registered at all.
 */
/**
 * Throws on a `subcommandModes` key that matches no `sub`, `group` or `group:sub` in the builder - a
 * typo there would otherwise silently leave e.g. a sensitive slash-only subcommand usable on prefix.
 */
export function assertSubcommandModeKeys(def: CommandDefinition): void {
    const known = new Set<string>();
    for (const opt of topLevelOptions(def)) {
        if (opt.type === SUB_COMMAND) known.add(opt.name);
        if (opt.type === SUB_COMMAND_GROUP) {
            known.add(opt.name);
            for (const s of opt.options ?? []) known.add(`${opt.name}:${s.name}`);
        }
    }
    const unknown = Object.keys(def.subcommandModes ?? {}).filter((k) => !known.has(k));
    if (unknown.length) {
        throw new Error(`/${def.name}: subcommandModes key(s) match no subcommand: ${unknown.join(", ")}`);
    }
}

export function buildSlashJson(def: CommandDefinition): RESTPostAPIChatInputApplicationCommandsJSONBody | null {
    assertSubcommandModeKeys(def);
    if (effectiveMode(def, null) === "prefix") return null;

    const base = def.options ? def.options.toJSON() : new SlashCommandBuilder().setName(def.name).setDescription(def.description).toJSON();

    const json: RESTPostAPIChatInputApplicationCommandsJSONBody = { ...base };
    if (base.options) {
        json.options = optionsForMode(def, base.options as RawOption[], "slash") as typeof base.options;
        if (hasSubcommands(def) && json.options?.length === 0) {
            throw new Error(`/${def.name}: no subcommands left for slash - declare modes: "prefix" instead`);
        }
    }
    if (def.guildOnly) json.contexts = [InteractionContextType.Guild];
    return json;
}
