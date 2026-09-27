import { ContainerBuilder, MessageFlags, SeparatorSpacingSize } from "discord.js";
import type { CommandDefinition } from "../../types";
import type { CommandMode } from "./command-context";
import { optionsForMode, type RawOption, SUB_COMMAND, SUB_COMMAND_GROUP } from "./command-dispatch";

// Usage/help rendering shared by `help` and the framework's automatic prefix usage (a prefix call
// with no/unknown subcommand). Everything is rendered for ONE mode, hiding subcommands that aren't
// available in it (`subcommandModes`), so nobody is told to run something that will be refused.

const ACCENT = 0x5865f2;

function addDivider(container: ContainerBuilder): void {
    container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
}

const ARG_TYPES = [3, 4, 5, 6, 7, 8, 10];
function formatArgList(options: RawOption[] | undefined, useFlagStyle: boolean): string {
    const args = (options ?? []).filter((o) => ARG_TYPES.includes(o.type));
    if (!args.length) return "";
    return " " + args.map((a) => {
        if (a.required) return `<${a.name}>`;
        return useFlagStyle ? `[--${a.name}]` : `[${a.name}]`;
    }).join(" ");
}

function formatSubcommandLine(invokeName: string, cmdName: string, path: string[], sub: RawOption, useFlagStyle: boolean): string {
    return `\`${invokeName}${cmdName} ${[...path, sub.name].join(" ")}${formatArgList(sub.options, useFlagStyle)}\` - ${sub.description}`;
}

function addRestrictions(container: ContainerBuilder, cmd: CommandDefinition): void {
    const flags: string[] = [];
    if (cmd.botOwnerOnly) flags.push("Developers only");
    if (cmd.adminOnly) flags.push("Administrators only");
    if (cmd.allowedUsers?.length) flags.push("Specific users");
    if (!flags.length) return;
    addDivider(container);
    container.addTextDisplayComponents((td) => td.setContent(`-# 🔒 Restrictions: ${flags.join(" · ")}`));
}

/**
 * Top-level view for a command (`/help <command>`).
 * For a command built from subcommands/groups, this is a *summary* — groups
 * are listed by name only (drill in with `/help <command> <group>`), loose
 * subcommands are listed in full since there's nothing further to drill into.
 */
function buildSummaryContainer(invokeName: string, cmd: CommandDefinition, topLevel: RawOption[], useFlagStyle: boolean): ContainerBuilder {
    const groups = topLevel.filter((o) => o.type === SUB_COMMAND_GROUP);
    const subcommands = topLevel.filter((o) => o.type === SUB_COMMAND);
    const plainArgs = topLevel.filter((o) => ARG_TYPES.includes(o.type));

    const description = groups.length
        ? `${cmd.description}\n-# Use \`${invokeName}help ${cmd.name} <group>\` to see a group's subcommands.`
        : cmd.description;

    const container = new ContainerBuilder().setAccentColor(ACCENT);
    container.addTextDisplayComponents((td) => td.setContent(`**${invokeName}${cmd.name}**\n${description}`));

    if (groups.length || subcommands.length) {
        addDivider(container);
        const lines = [
            ...groups.map((g) => `\`${invokeName}${cmd.name} ${g.name}\` (group) - ${g.description}`),
            ...subcommands.map((s) => formatSubcommandLine(invokeName, cmd.name, [], s, useFlagStyle)),
        ];
        container.addTextDisplayComponents((td) => td.setContent(["**Subcommands**", ...lines].join("\n")));
    } else if (plainArgs.length) {
        addDivider(container);
        const lines = plainArgs.map((a) => `- \`${a.name}\`${a.required ? " \\*" : ""} - ${a.description}`);
        container.addTextDisplayComponents((td) => td.setContent(["**Arguments**", ...lines].join("\n")));
    }

    addRestrictions(container, cmd);
    return container;
}

/** Group view (`/help <command> <group>`) — lists that group's subcommands. */
function buildGroupContainer(invokeName: string, cmd: CommandDefinition, group: RawOption, useFlagStyle: boolean): ContainerBuilder {
    const container = new ContainerBuilder().setAccentColor(ACCENT);
    container.addTextDisplayComponents((td) => td.setContent(`**${invokeName}${cmd.name} ${group.name}**\n${group.description}`));

    const lines = (group.options ?? [])
        .filter((s) => s.type === SUB_COMMAND)
        .map((s) => formatSubcommandLine(invokeName, cmd.name, [group.name], s, useFlagStyle));
    if (lines.length) {
        addDivider(container);
        container.addTextDisplayComponents((td) => td.setContent(["**Subcommands**", ...lines].join("\n")));
    }

    addRestrictions(container, cmd);
    return container;
}

/** Leaf view (`/help <command> [group] <subcommand>`) — a single subcommand's arguments. */
function buildLeafContainer(invokeName: string, cmd: CommandDefinition, path: string[], leaf: RawOption, useFlagStyle: boolean): ContainerBuilder {
    const container = new ContainerBuilder().setAccentColor(ACCENT);
    const label = `${invokeName}${[cmd.name, ...path, leaf.name].join(" ")}`;
    container.addTextDisplayComponents((td) =>
        td.setContent(`**${label}${formatArgList(leaf.options, useFlagStyle)}**\n${leaf.description}`),
    );

    const args = (leaf.options ?? []).filter((o) => ARG_TYPES.includes(o.type));
    if (args.length) {
        addDivider(container);
        const lines = args.map((a) => {
            const label = a.required ? `\`${a.name}\` (required)` : useFlagStyle ? `\`--${a.name}\`` : `\`${a.name}\``;
            return `- ${label}\n> ${a.description}`;
        });
        container.addTextDisplayComponents((td) => td.setContent(["**Arguments**", ...lines].join("\n")));
    }

    addRestrictions(container, cmd);
    return container;
}


/**
 * Resolves `help <command> [...path]` into the right container, for `mode`.
 * `path` is empty for the top-level summary, `[group]` or `[subcommand]` for
 * one level down, and `[group, subcommand]` for a leaf under a group.
 * Returns `null` if `path` doesn't resolve to anything (in that mode).
 */
export function buildHelpContainer(invokeName: string, cmd: CommandDefinition, path: string[], useFlagStyle: boolean, mode: CommandMode): ContainerBuilder | null {
    const json = cmd.options?.toJSON() as { options?: RawOption[] } | undefined;
    const topLevel = optionsForMode(cmd, json?.options ?? [], mode);

    if (path.length === 0) return buildSummaryContainer(invokeName, cmd, topLevel, useFlagStyle);

    const [first, second] = path;
    const group = topLevel.find((o) => o.type === SUB_COMMAND_GROUP && o.name === first);
    if (group) {
        if (path.length === 1) return buildGroupContainer(invokeName, cmd, group, useFlagStyle);
        if (path.length !== 2) return null;
        const leaf = (group.options ?? []).find((s) => s.type === SUB_COMMAND && s.name === second);
        return leaf ? buildLeafContainer(invokeName, cmd, [first], leaf, useFlagStyle) : null;
    }

    const topSub = topLevel.find((o) => o.type === SUB_COMMAND && o.name === first);
    if (topSub && path.length === 1) return buildLeafContainer(invokeName, cmd, [], topSub, useFlagStyle);

    return null;
}

/**
 * The reply payload for a command's usage in `mode` - a bare group gets that group's view, falling
 * back to the top-level summary when that resolves to nothing (e.g. every sub in the group is
 * unavailable in this mode), so a usage request never ends in silence.
 */
export function buildUsagePayload(cmd: CommandDefinition, invokePrefix: string, group: string | null, mode: CommandMode, useFlagStyle: boolean) {
    const container = (group && buildHelpContainer(invokePrefix, cmd, [group], useFlagStyle, mode))
        || buildHelpContainer(invokePrefix, cmd, [], useFlagStyle, mode);
    return container ? { components: [container], flags: MessageFlags.IsComponentsV2 as const } : null;
}
