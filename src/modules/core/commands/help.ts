import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { defineCommand } from "@/define";
import { CommandCategory, type CommandDefinition } from "@/types";
import { config } from "../../../config";
import { getGuildPrefix } from "../../../database/guildRepository";
import type { BotClient } from "@/core/BotClient";
import { Logger } from "@/utils/logging";
import { attachPagination, buildPaginationRow } from "@/utils/pagination";

const logger = new Logger("core.commands.help");

const PER_PAGE = 5;

// ─── Shared builders ──────────────────────────────────────────────────────────

function buildEmbed(
    page: number,
    all: CommandDefinition[],
    pages: number,
    prefix: string,
): EmbedBuilder {
    const slice = all.slice(page * PER_PAGE, (page + 1) * PER_PAGE);
    return new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("📋 Commands")
        .setDescription(`Use \`/help <command>\` or \`${prefix}help <command>\` for details.\n\u200b`)
        .setFooter({ text: `Page ${page + 1} of ${pages} · ${all.length} commands` })
        .addFields(slice.map((cmd) => ({ name: `/${cmd.name}`, value: cmd.description, inline: false })));
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

/** Splits an already-newline-joined list of lines into <=1024-char embed field chunks. */
function chunkLines(lines: string[], limit = 1024): string[] {
    const chunks: string[] = [];
    let current: string[] = [];
    let length = 0;

    for (const line of lines) {
        if (current.length && length + 1 + line.length > limit) {
            chunks.push(current.join("\n"));
            current = [];
            length = 0;
        }
        current.push(line);
        length += (current.length > 1 ? 1 : 0) + line.length;
    }
    if (current.length) chunks.push(current.join("\n"));
    return chunks;
}

function addFieldChunks(embed: EmbedBuilder, name: string, lines: string[]): void {
    chunkLines(lines).forEach((value, i) => {
        embed.addFields({ name: i === 0 ? name : "​", value });
    });
}

function addRestrictions(embed: EmbedBuilder, cmd: CommandDefinition): void {
    const flags: string[] = [];
    if (cmd.botOwnerOnly) flags.push("Developers only");
    if (cmd.adminOnly) flags.push("Administrators only");
    if (cmd.allowedUsers?.length) flags.push("Specific users");
    if (flags.length) embed.addFields({ name: "Restrictions", value: flags.join(" · ") });
}

/**
 * Top-level view for a command (`/help <command>`).
 * For a command built from subcommands/groups, this is a *summary* — groups
 * are listed by name only (drill in with `/help <command> <group>`), loose
 * subcommands are listed in full since there's nothing further to drill into.
 */
function buildSummaryEmbed(invokeName: string, cmd: CommandDefinition, topLevel: RawOption[], useFlagStyle: boolean): EmbedBuilder {
    const groups = topLevel.filter((o) => o.type === SUB_COMMAND_GROUP);
    const subcommands = topLevel.filter((o) => o.type === SUB_COMMAND);
    const plainArgs = topLevel.filter((o) => ARG_TYPES.includes(o.type));

    const description = groups.length
        ? `${cmd.description}\n\nUse \`${invokeName}help ${cmd.name} <group>\` to see a group's subcommands.`
        : cmd.description;

    const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(`${invokeName}${cmd.name}`).setDescription(description);

    if (groups.length || subcommands.length) {
        const lines = [
            ...groups.map((g) => `\`${invokeName}${cmd.name} ${g.name}\` (group) - ${g.description}`),
            ...subcommands.map((s) => formatSubcommandLine(invokeName, cmd.name, [], s, useFlagStyle)),
        ];
        addFieldChunks(embed, "Subcommands", lines);
    } else if (plainArgs.length) {
        addFieldChunks(
            embed,
            "Arguments",
            plainArgs.map((a) => `\`${a.name}\`${a.required ? " \\*" : ""} - ${a.description}`),
        );
    }

    addRestrictions(embed, cmd);
    return embed;
}

/** Group view (`/help <command> <group>`) — lists that group's subcommands. */
function buildGroupEmbed(invokeName: string, cmd: CommandDefinition, group: RawOption, useFlagStyle: boolean): EmbedBuilder {
    const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`${invokeName}${cmd.name} ${group.name}`)
        .setDescription(group.description);

    const lines = (group.options ?? [])
        .filter((s) => s.type === SUB_COMMAND)
        .map((s) => formatSubcommandLine(invokeName, cmd.name, [group.name], s, useFlagStyle));
    addFieldChunks(embed, "Subcommands", lines);

    addRestrictions(embed, cmd);
    return embed;
}

/** Leaf view (`/help <command> [group] <subcommand>`) — a single subcommand's arguments. */
function buildLeafEmbed(invokeName: string, cmd: CommandDefinition, path: string[], leaf: RawOption, useFlagStyle: boolean): EmbedBuilder {
    const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`${invokeName}${[cmd.name, ...path, leaf.name].join(" ")}`)
        .setDescription(leaf.description);

    const args = (leaf.options ?? []).filter((o) => ARG_TYPES.includes(o.type));
    if (args.length) {
        addFieldChunks(
            embed,
            "Arguments",
            args.map((a) => {
                const label = a.required ? `\`${a.name}\` (required)` : useFlagStyle ? `\`--${a.name}\`` : `\`${a.name}\``;
                return `- ${label}\n> ${a.description}\n`;
            }),
        );
    }

    addRestrictions(embed, cmd);
    return embed;
}

/**
 * Resolves `/help <command> [...path]` into the right embed.
 * `path` is empty for the top-level summary, `[group]` or `[subcommand]` for
 * one level down, and `[group, subcommand]` for a leaf under a group.
 * Returns `null` if `path` doesn't resolve to anything.
 */
function buildHelpEmbed(invokeName: string, cmd: CommandDefinition, path: string[], useFlagStyle: boolean): EmbedBuilder | null {
    const json = cmd.options?.toJSON() as { options?: RawOption[] } | undefined;
    const topLevel = json?.options ?? [];

    if (path.length === 0) return buildSummaryEmbed(invokeName, cmd, topLevel, useFlagStyle);

    const [first, second] = path;
    const group = topLevel.find((o) => o.type === SUB_COMMAND_GROUP && o.name === first);
    if (group) {
        if (path.length === 1) return buildGroupEmbed(invokeName, cmd, group, useFlagStyle);
        if (path.length !== 2) return null;
        const leaf = (group.options ?? []).find((s) => s.type === SUB_COMMAND && s.name === second);
        return leaf ? buildLeafEmbed(invokeName, cmd, [first], leaf, useFlagStyle) : null;
    }

    const topSub = topLevel.find((o) => o.type === SUB_COMMAND && o.name === first);
    if (topSub && path.length === 1) return buildLeafEmbed(invokeName, cmd, [], topSub, useFlagStyle);

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
        const prefix = interaction.guild
            ? await getGuildPrefix(interaction.guild.id)
            : config.bot.defaultPrefix;

        // Detail view
        if (cmdName) {
            const [base, ...path] = cmdName.trim().toLowerCase().split(/\s+/);
            const cmd = client.commands.get(base);
            if (!cmd || !cmd.showOnHelp) {
                if (!cmd?.showOnHelp) logger.warn(`User ${interaction.user.id} tried to view hidden command: ${cmdName}`);
                await interaction.reply({ content: `❌ Command \`${cmdName}\` not found.`, ephemeral: true });
                return;
            }
            const embed = buildHelpEmbed("/", cmd, path, false);
            if (!embed) {
                await interaction.reply({ content: `❌ Subcommand \`${cmdName}\` not found.`, ephemeral: true });
                return;
            }
            await interaction.reply({ embeds: [embed] });
            return;
        }

        // List view
        const all = getVisibleCommands(client);
        const pages = Math.ceil(all.length / PER_PAGE);

        await interaction.deferReply();
        const msg = await interaction.editReply({
            embeds: [buildEmbed(0, all, pages, prefix)],
            components: pages > 1 ? [buildPaginationRow(0, pages)] : [],
        });

        if (pages <= 1) return;

        attachPagination(msg, {
            invokerId: interaction.user.id,
            pages,
            render: (page, interactive) => ({
                embeds: [buildEmbed(page, all, pages, prefix)],
                components: interactive ? [buildPaginationRow(page, pages)] : [],
            }),
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
                await message.reply(`❌ Command \`${cmdName}\` not found.`);
                return;
            }
            const embed = buildHelpEmbed(prefix, cmd, path, config.bot.allowArgsAsFlags);
            if (!embed) {
                await message.reply(`❌ Subcommand \`${cmdName}\` not found.`);
                return;
            }
            await message.reply({ embeds: [embed] });
            return;
        }

        // List view
        const all = getVisibleCommands(client);
        const pages = Math.ceil(all.length / PER_PAGE);

        const sent = await message.reply({
            embeds: [buildEmbed(0, all, pages, prefix)],
            components: pages > 1 ? [buildPaginationRow(0, pages)] : [],
        });

        if (pages <= 1) return;

        attachPagination(sent, {
            invokerId: message.author.id,
            pages,
            render: (page, interactive) => ({
                embeds: [buildEmbed(page, all, pages, prefix)],
                components: interactive ? [buildPaginationRow(page, pages)] : [],
            }),
        });
    },
});
