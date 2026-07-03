import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
    EmbedBuilder,
    SlashCommandBuilder,
} from "discord.js";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import { config } from "../../../config";
import { getGuildPrefix } from "../../../database/guildRepository";
import { Logger } from "@/utils/logging";

const logger = new Logger("core.commands.help");

const PER_PAGE = 5;

export default defineCommand({
    name: "help",
    description: "Lists all available commands.",
    category: CommandCategory.UTILITY,
    hidden: false,

    options: new SlashCommandBuilder().addStringOption((opt) =>
        opt
            .setName("command")
            .setDescription("Command name to check details")
            .setRequired(false),
    ),

    async execute(ctx) {
        const cmdName = ctx.args.getString("command");
        const prefix = ctx.guild
            ? await getGuildPrefix(ctx.guild.id)
            : config.bot.defaultPrefix;

        // ── Detail view ───────────────────────────────────────────────────────
        if (cmdName) {
            const cmd = ctx.client.commands.get(cmdName.toLowerCase());
            if (!cmd) {
                await ctx.reply({ content: `❌ Command \`${cmdName}\` not found.`, ephemeral: true, deleteAfter: 5000 });
                return;
            }

            if (cmd.hidden) {
                await ctx.reply({ content: `❌ Command \`${cmdName}\` not found.`, ephemeral: true, deleteAfter: 5000 });
                logger.warn(`User ${ctx.user.id} (${ctx.user.username}) tried to use a hidden command: ${cmdName}`);
                return;
            }

            const json = cmd.options?.toJSON();
            const cmdArgs = json?.options?.filter((o) =>
                [3, 4, 5, 6, 7, 8, 10].includes(o.type),
            );

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
            if (cmd.prefixEnabled === false) flags.push("Slash only");
            if (cmd.ownerOnly) flags.push("Developers only");
            if (cmd.adminOnly) flags.push("Administrators only");
            if (cmd.allowedUsers?.length) flags.push("Specific users");
            if (flags.length) embed.addFields({ name: "Restrictions", value: flags.join(" · ") });

            await ctx.reply({ embeds: [embed] });
            return;
        }

        // ── List view (paginated) ─────────────────────────────────────────────
        const all = ctx.client.commands
            .getAll()
            .filter((c) => c.hidden !== true)
            .sort((a, b) => a.name!.localeCompare(b.name!));

        const pages = Math.ceil(all.length / PER_PAGE);

        function buildEmbed(page: number): EmbedBuilder {
            const slice = all.slice(page * PER_PAGE, (page + 1) * PER_PAGE);
            const embed = new EmbedBuilder()
                .setColor(0x5865f2)
                .setTitle("📋 Commands")
                .setDescription(
                    `Use \`/help <command>\` or \`${prefix}help <command>\` for details.\n\u200b`,
                )
                .setFooter({ text: `Page ${page + 1} of ${pages} · ${all.length} commands` });

            for (const cmd of slice) {
                embed.addFields({
                    name: `/${cmd.name}`,
                    value: cmd.description,
                    inline: false,
                });
            }

            return embed;
        }

        function buildRow(page: number): ActionRowBuilder<ButtonBuilder> {
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

        let page = 0;
        await ctx.deferReply();

        const msg = await ctx.reply({ embeds: [buildEmbed(0)], components: pages > 1 ? [buildRow(0)] : [] });

        if (pages <= 1 || !("createMessageComponentCollector" in msg)) return;

        const collector = (msg as never as { createMessageComponentCollector: Function }).createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: 60_000,
        });

        collector.on("collect", async (i: never) => {
            const interaction = i as { customId: string; user: { id: string }; update: Function };
            if (interaction.user.id !== ctx.user.id) return;
            if (interaction.customId === "prev" && page > 0) page--;
            if (interaction.customId === "next" && page < pages - 1) page++;
            await interaction.update({
                embeds: [buildEmbed(page)],
                components: [buildRow(page)],
            });
        });

        collector.on("end", async () => {
            await ctx.editReply({ components: [] }).catch(() => { });
        });
    },
});
