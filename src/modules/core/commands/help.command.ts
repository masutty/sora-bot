import { ContainerBuilder, MessageFlags, SeparatorSpacingSize, SlashCommandBuilder } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { buildHelpContainer, defineCommand, paginate, UserFacingError } from "@/define";
import { CommandCategory, type CommandDefinition } from "@/types";
import { Logger } from "@/utils/logging";
import { config } from "../../../config";

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

function renderPage(page: number, all: CommandDefinition[], pages: number, prefix: string) {
    return {
        flags: MessageFlags.IsComponentsV2 as const,
        components: [buildListContainer(page, all, pages, prefix)],
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
        opt.setName("command").setDescription("Command name to check details").setRequired(false),
    ),

    async run(ctx) {
        const cmdName = ctx.args.getString("command");
        const useFlagStyle = ctx.mode === "prefix" && config.bot.allowArgsAsFlags;

        // Detail view
        if (cmdName) {
            const [base, ...path] = cmdName.trim().toLowerCase().split(/\s+/);
            const cmd = ctx.client.commands.get(base);
            if (!cmd?.showOnHelp) {
                if (!cmd?.showOnHelp) logger.warn(`User ${ctx.user.id} tried to view hidden command: ${cmdName}`);
                throw new UserFacingError(`Command \`${cmdName}\` not found.`);
            }
            const container = buildHelpContainer(ctx.invokePrefix, cmd, path, useFlagStyle, ctx.mode);
            if (!container) throw new UserFacingError(`Subcommand \`${cmdName}\` not found.`);
            await ctx.reply({ flags: MessageFlags.IsComponentsV2, components: [container] });
            return;
        }

        // List view
        const all = getVisibleCommands(ctx.client);
        const pages = Math.ceil(all.length / PER_PAGE);

        // A single page needs no navigation - just reply, same as test.command.ts's openTestPages.
        if (pages <= 1) {
            await ctx.reply(renderPage(0, all, pages, ctx.invokePrefix));
            return;
        }

        await ctx.open(
            paginate({
                name: "core.help",
                pages,
                renderPage: (page) => renderPage(page, all, pages, ctx.invokePrefix),
            }),
            undefined,
        );
    },
});
