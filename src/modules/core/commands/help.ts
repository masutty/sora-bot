import { ContainerBuilder, MessageFlags, SeparatorSpacingSize, SlashCommandBuilder } from "discord.js";
import { defineCommand } from "@/define";
import { CommandCategory, type CommandDefinition } from "@/types";
import { config } from "../../../config";
import { getGuildPrefix } from "../../../database/guildRepository";
import type { BotClient } from "@/core/BotClient";
import { EmbedFormatter } from "@/utils/format";
import { Logger } from "@/utils/logging";
import { attachPagination, buildPaginationRow } from "@/utils/pagination";

const logger = new Logger("core.commands.help");

const PER_PAGE = 5;
const ACCENT = 0x5865f2;

function addDivider(container: ContainerBuilder): void {
    container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
}

// ─── Shared builders ──────────────────────────────────────────────────────────

function buildListContainer(page: number, all: CommandDefinition[], pages: number, prefix: string): ContainerBuilder {
    const slice = all.slice(page * PER_PAGE, (page + 1) * PER_PAGE);
    const container = new ContainerBuilder().setAccentColor(ACCENT);

    container.addTextDisplayComponents((td) =>
        td.setContent(`**📋 Commands**\n-# Use \`/help <command>\` or \`${prefix}help <command>\` for details.`),
    );

    slice.forEach((cmd) => {
        addDivider(container);
        container.addTextDisplayComponents((td) => td.setContent(`**/${cmd.name}**\n${cmd.description}`));
    });

    addDivider(container);
    container.addTextDisplayComponents((td) => td.setContent(`-# Page ${page + 1} of ${pages} · ${all.length} commands`));

    return container;
}

function renderList(page: number, interactive: boolean, all: CommandDefinition[], pages: number, prefix: string) {
    return {
        flags: MessageFlags.IsComponentsV2 as const,
        components: [
            buildListContainer(page, all, pages, prefix),
            ...(interactive ? [buildPaginationRow(page, pages)] : []),
        ],
    };
}

const ARG_TYPES = [3, 4, 5, 6, 7, 8, 10];
const SUB_COMMAND = 1;
const SUB_COMMAND_GROUP = 2;

interface RawOption {
    name: string;
    description: string;
    type: number;
    required?: boolean;
    options?: RawOption[];
}

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
 * Resolves `/help <command> [...path]` into the right container.
 * `path` is empty for the top-level summary, `[group]` or `[subcommand]` for
 * one level down, and `[group, subcommand]` for a leaf under a group.
 * Returns `null` if `path` doesn't resolve to anything.
 */
function buildHelpContainer(invokeName: string, cmd: CommandDefinition, path: string[], useFlagStyle: boolean): ContainerBuilder | null {
    const json = cmd.options?.toJSON() as { options?: RawOption[] } | undefined;
    const topLevel = json?.options ?? [];

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

function getVisibleCommands(client: BotClient): CommandDefinition[] {
    return client.commands
        .getAll()
        .filter((c) => c.showOnHelp !== false)
        .sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Command ──────────────────────────────────────────────────────────────────

export default defineCommand({
    name: "help",
    description: "Lists all available commands.",
    category: CommandCategory.UTILITY,
    showOnHelp: false,

    options: new SlashCommandBuilder().addStringOption((opt) =>
        opt
            .setName("command")
            .setDescription("Command name to check details")
            .setRequired(false),
    ),

    // ── Slash ─────────────────────────────────────────────────────────────────
    async executeAsSlash(interaction, client) {
        const cmdName = interaction.options.getString("command");

        // Detail view
        if (cmdName) {
            const [base, ...path] = cmdName.trim().toLowerCase().split(/\s+/);
            const cmd = client.commands.get(base);
            if (!cmd || !cmd.showOnHelp) {
                if (!cmd?.showOnHelp) logger.warn(`User ${interaction.user.id} tried to view hidden command: ${cmdName}`);
                await interaction.reply({ ...EmbedFormatter.error(`Command \`${cmdName}\` not found.`), ephemeral: true });
                return;
            }
            const container = buildHelpContainer("/", cmd, path, false);
            if (!container) {
                await interaction.reply({ ...EmbedFormatter.error(`Subcommand \`${cmdName}\` not found.`), ephemeral: true });
                return;
            }
            await interaction.reply({ flags: MessageFlags.IsComponentsV2, components: [container] });
            return;
        }

        // List view
        const all = getVisibleCommands(client);
        const pages = Math.ceil(all.length / PER_PAGE);

        await interaction.deferReply();
        const msg = await interaction.editReply(renderList(0, pages > 1, all, pages, "/"));

        if (pages <= 1) return;

        attachPagination(msg, {
            invokerId: interaction.user.id,
            pages,
            render: (page, interactive) => renderList(page, interactive, all, pages, "/"),
        });
    },

    // ── Prefix ────────────────────────────────────────────────────────────────
    async executeAsPrefix(message, args, client) {
        const cmdName = args.getString("command");
        const prefix = message.guild
            ? await getGuildPrefix(message.guild.id)
            : config.bot.defaultPrefix;

        // Detail view
        if (cmdName) {
            const [base, ...path] = cmdName.trim().toLowerCase().split(/\s+/);
            const cmd = client.commands.get(base);
            if (!cmd || !cmd.showOnHelp) {
                if (!cmd?.showOnHelp) logger.warn(`User ${message.author.id} tried to view hidden command: ${cmdName}`);
                await message.reply(EmbedFormatter.error(`Command \`${cmdName}\` not found.`));
                return;
            }
            const container = buildHelpContainer(prefix, cmd, path, config.bot.allowArgsAsFlags);
            if (!container) {
                await message.reply(EmbedFormatter.error(`Subcommand \`${cmdName}\` not found.`));
                return;
            }
            await message.reply({ flags: MessageFlags.IsComponentsV2, components: [container] });
            return;
        }

        // List view
        const all = getVisibleCommands(client);
        const pages = Math.ceil(all.length / PER_PAGE);

        const sent = await message.reply(renderList(0, pages > 1, all, pages, prefix));

        if (pages <= 1) return;

        attachPagination(sent, {
            invokerId: message.author.id,
            pages,
            render: (page, interactive) => renderList(page, interactive, all, pages, prefix),
        });
    },
});
