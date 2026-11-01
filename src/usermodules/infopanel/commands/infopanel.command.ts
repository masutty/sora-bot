import { AttachmentBuilder, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { defineCommand, type GuildCommandContext, UserFacingError } from "@/define";
import { CommandCategory } from "@/types";
import { NO_PINGS } from "@/utils/format";
import { listPanels } from "../repository/panels.repository";
import { exportPanel, importPanelFile, MAX_IMPORT_BYTES } from "../services/panel-transfer";
import { defaultEditorDeps, panelEditorView } from "../views/panel-editor.view";

const MAX_CHOICES = 25;

/** `/infopanel export:<panel>` - sends the panel as a JSON file. */
async function runExport(ctx: GuildCommandContext, ref: string): Promise<void> {
    const { file, fileName } = await exportPanel(ctx.guild.id, ref);
    await ctx.reply(
        {
            content: `Exported **${file.panel.name}**. Create it on any server with \`/infopanel import\`.`,
            files: [new AttachmentBuilder(Buffer.from(JSON.stringify(file, null, 4)), { name: fileName })],
            allowedMentions: NO_PINGS,
        },
        { ephemeral: true },
    );
}

/** `/infopanel import:<file>` - slash only, a prefix call has no attachment option to read. Always creates a new panel. */
async function runImport(ctx: GuildCommandContext): Promise<void> {
    if (ctx.raw.kind !== "slash") throw new UserFacingError("Import only works as a slash command.");
    const attachment = ctx.raw.interaction.options.getAttachment("import", true);
    if (attachment.size > MAX_IMPORT_BYTES) throw new UserFacingError("That file is too big to be a panel export.");

    const response = await fetch(attachment.url);
    if (!response.ok) throw new UserFacingError(`I couldn't download the file (HTTP ${response.status}).`);
    const text = await response.text();

    const deps = defaultEditorDeps(ctx.client, ctx.guild.id);
    const { panel, options, droppedEmoji } = await importPanelFile(ctx.guild.id, text, deps.hasCustomEmoji);
    const dropped = droppedEmoji > 0 ? ` ${droppedEmoji} emoji left out: this bot can't use them.` : "";
    await ctx.reply(
        {
            content: `Imported **${panel.name}** with ${options} ${options === 1 ? "option" : "options"}. Open \`/infopanel\` to post it.${dropped}`,
            allowedMentions: NO_PINGS,
        },
        { ephemeral: true },
    );
}

export default defineCommand({
    name: "infopanel",
    description: "Build panels with a select that opens pages.",
    category: CommandCategory.ADMIN,
    showOnHelp: true,
    adminOnly: true,
    guildOnly: true,

    options: new SlashCommandBuilder()
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addStringOption((o) => o.setName("export").setDescription("Download a panel as a file").setAutocomplete(true))
        .addAttachmentOption((o) => o.setName("import").setDescription("Create a panel from an exported file")),

    async executeAutocomplete(interaction) {
        if (!interaction.guildId) return interaction.respond([]);
        const typed = interaction.options.getFocused().toLowerCase();
        const panels = await listPanels(interaction.guildId);
        await interaction.respond(
            panels
                .filter((m) => m.name.toLowerCase().includes(typed))
                .slice(0, MAX_CHOICES)
                .map((m) => ({ name: m.name, value: String(m.id) })),
        );
    },

    async run(ctx) {
        const exportRef = ctx.args.getString("export");
        const importing = ctx.raw.kind === "slash" && ctx.raw.interaction.options.getAttachment("import") !== null;
        if (exportRef && importing) throw new UserFacingError("Pick export or import, not both.");
        if (exportRef) return runExport(ctx, exportRef);
        if (importing) return runImport(ctx);
        await ctx.open(panelEditorView(defaultEditorDeps(ctx.client, ctx.guild.id)), undefined, { ephemeral: true });
    },
});
