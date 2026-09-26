import { ContainerBuilder, MessageFlags, SeparatorSpacingSize, SlashCommandBuilder } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { buildHelpContainer, defineCommand } from "@/define";
import { CommandCategory, type CommandDefinition } from "@/types";
import { EmbedFormatter } from "@/utils/format";
import { Logger } from "@/utils/logging";
import { attachPagination, buildPaginationRow } from "@/utils/pagination";
import { config } from "../../../config";
import { getGuildPrefix } from "../../../database/guild.repository";

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
            const container = buildHelpContainer("/", cmd, path, false, "slash");
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
            const container = buildHelpContainer(prefix, cmd, path, config.bot.allowArgsAsFlags, "prefix");
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
