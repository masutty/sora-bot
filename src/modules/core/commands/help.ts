import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
    EmbedBuilder,
    SlashCommandBuilder,
    type Message,
} from "discord.js";
import { defineCommand } from "@/define";
import { CommandCategory, type CommandDefinition } from "@/types";
import { config } from "../../../config";
import { getGuildPrefix } from "../../../database/guildRepository";
import type { BotClient } from "@/core/BotClient";
import { Logger } from "@/utils/logging";

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

function buildRow(page: number, pages: number): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId("prev")
            .setEmoji("◀️")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page === 0),
        new ButtonBuilder()
            .setCustomId("next")
            .setEmoji("▶️")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page === pages - 1),
    );
}

function buildDetailEmbed(cmd: CommandDefinition): EmbedBuilder {
    const json = cmd.options?.toJSON();
    const cmdArgs = json?.options?.filter((o) => [3, 4, 5, 6, 7, 8, 10].includes(o.type));

    const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`/${cmd.name}`)
        .setDescription(cmd.description);

    if (cmdArgs?.length) {
        embed.addFields({
            name: "Arguments",
            value: cmdArgs
                .map((a) => `\`${a.name}\`${a.required ? " \\*" : ""} — ${a.description}`)
                .join("\n"),
        });
    }

    const flags: string[] = [];
    if (cmd.botOwnerOnly) flags.push("Developers only");
    if (cmd.adminOnly) flags.push("Administrators only");
    if (cmd.allowedUsers?.length) flags.push("Specific users");
    if (flags.length) embed.addFields({ name: "Restrictions", value: flags.join(" · ") });

    return embed;
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
            const cmd = client.commands.get(cmdName.toLowerCase());
            if (!cmd || !cmd.showOnHelp) {
                if (!cmd?.showOnHelp) logger.warn(`User ${interaction.user.id} tried to view hidden command: ${cmdName}`);
                await interaction.reply({ content: `❌ Command \`${cmdName}\` not found.`, ephemeral: true });
                return;
            }
            await interaction.reply({ embeds: [buildDetailEmbed(cmd)] });
            return;
        }

        // List view
        const all = getVisibleCommands(client);
        const pages = Math.ceil(all.length / PER_PAGE);

        await interaction.deferReply();
        const msg = await interaction.editReply({
            embeds: [buildEmbed(0, all, pages, prefix)],
            components: pages > 1 ? [buildRow(0, pages)] : [],
        });

        if (pages <= 1) return;

        let page = 0;
        const collector = msg.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: 60_000,
        });

        collector.on("collect", async (i) => {
            if (i.user.id !== interaction.user.id) return;
            if (i.customId === "prev" && page > 0) page--;
            if (i.customId === "next" && page < pages - 1) page++;
            await i.update({
                embeds: [buildEmbed(page, all, pages, prefix)],
                components: [buildRow(page, pages)],
            });
        });

        collector.on("end", async () => {
            await interaction.editReply({ components: [] }).catch(() => { });
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
            const cmd = client.commands.get(cmdName.toLowerCase());
            if (!cmd || !cmd.showOnHelp) {
                if (!cmd?.showOnHelp) logger.warn(`User ${message.author.id} tried to view hidden command: ${cmdName}`);
                await message.reply(`❌ Command \`${cmdName}\` not found.`);
                return;
            }
            await message.reply({ embeds: [buildDetailEmbed(cmd)] });
            return;
        }

        // List view
        const all = getVisibleCommands(client);
        const pages = Math.ceil(all.length / PER_PAGE);

        let page = 0;
        const sent = await message.reply({
            embeds: [buildEmbed(0, all, pages, prefix)],
            components: pages > 1 ? [buildRow(0, pages)] : [],
        });

        if (pages <= 1) return;

        const collector = sent.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: 60_000,
        });

        collector.on("collect", async (i) => {
            // Only the original invoker can paginate
            if (i.user.id !== message.author.id) {
                await i.reply({ content: "These buttons aren't yours!", ephemeral: true });
                return;
            }
            if (i.customId === "prev" && page > 0) page--;
            if (i.customId === "next" && page < pages - 1) page++;
            await i.update({
                embeds: [buildEmbed(page, all, pages, prefix)],
                components: [buildRow(page, pages)],
            });
        });

        collector.on("end", async () => {
            await sent.edit({ components: [] }).catch(() => { });
        });
    },
});
