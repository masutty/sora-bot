import {
    AttachmentBuilder,
    type AutocompleteInteraction,
    MessageFlags,
    type SlashCommandSubcommandBuilder,
    type SlashCommandSubcommandGroupBuilder,
} from "discord.js";
import type { CommandArgs } from "@/core/command/command-args";
import { type CommandContext, confirm } from "@/define";
import { EmbedFormatter, type FormattedReply, NO_PINGS } from "@/utils/format";
import {
    ALL_BIOME_CATEGORIES,
    ANSI_BACKGROUND_COLORS,
    ANSI_TEXT_COLORS,
    BIOME_CATEGORY_LABELS,
    type BiomeEntry,
    biomeAutocompleteChoices,
    getAllBiomes,
} from "../constants/biomes.constants";
import { type AnsiInput, addBiome, CLEAR_VALUE, editBiome, setBiomeActive } from "../services/biome-admin.service";
import {
    applyBiomeImport,
    type BiomeImportPlan,
    exportCurrentBiomes,
    parseBiomeConfig,
    planBiomeImport,
} from "../services/biome-config.service";
import { BiomeHuntError } from "../types";
import { biomeListView, buildBiomeCard } from "../views/biome-list.view";

const CATEGORY_CHOICES = ALL_BIOME_CATEGORIES.map((c) => ({ name: BIOME_CATEGORY_LABELS[c], value: c }));
const NO_COLOR_CHOICE = { name: "None", value: CLEAR_VALUE };
const ANSI_TEXT_CHOICES = [NO_COLOR_CHOICE, ...ANSI_TEXT_COLORS.map((c) => ({ name: c.name, value: c.slug }))];
const ANSI_BACKGROUND_CHOICES = [NO_COLOR_CHOICE, ...ANSI_BACKGROUND_COLORS.map((c) => ({ name: c.name, value: c.slug }))];

/** Where a biome's ANSI style shows - its name inside the `ansi` codeblocks of these screens. */
const ANSI_WHERE = "in /bh profile, /bh-stats and session-end reports";

/** The fields `add` and `edit` share - on `edit` none is required and only the given ones change. */
function addSharedBiomeOptions(s: SlashCommandSubcommandBuilder, required: boolean): SlashCommandSubcommandBuilder {
    const removable = required ? "" : ` - "${CLEAR_VALUE}" removes it`;
    return s
        .addStringOption((o) =>
            o
                .setName("category")
                .setDescription("Category - Admin = tracked only: no Seeds/XP, no vote, not in the Network")
                .setRequired(required)
                .addChoices(...CATEGORY_CHOICES),
        )
        .addStringOption((o) =>
            o
                .setName("color")
                .setDescription("6 hex digits, no # (e.g. ff8c00) - side bar of forward cards and Network mirrors")
                .setRequired(required)
                .setMinLength(6)
                .setMaxLength(6),
        )
        .addStringOption((o) => o.setName("flavor_text").setDescription(`One line under the title on forward cards${removable}`))
        .addStringOption((o) => o.setName("icon_url").setDescription(`https:// image on forward cards${removable}`))
        .addStringOption((o) =>
            o
                .setName("ansi_text")
                .setDescription(`Name text color ${ANSI_WHERE}`)
                .addChoices(...ANSI_TEXT_CHOICES),
        )
        .addStringOption((o) =>
            o
                .setName("ansi_background")
                .setDescription(`Name background color ${ANSI_WHERE}`)
                .addChoices(...ANSI_BACKGROUND_CHOICES),
        )
        .addBooleanOption((o) => o.setName("ansi_bold").setDescription(`Bold name ${ANSI_WHERE}`));
}

/** `/bh-owner biome ...` - the bot owner's runtime biome registry (see `bh_biomes`). */
export function biomeAdminSubcommandGroup(g: SlashCommandSubcommandGroupBuilder): SlashCommandSubcommandGroupBuilder {
    return g
        .setName("biome")
        .setDescription("Add, edit, enable or disable the biomes the bot recognizes.")
        .addSubcommand((s) =>
            addSharedBiomeOptions(
                s
                    .setName("add")
                    .setDescription("Registers a new biome - recognized from macros and offered in pickers right away.")
                    .addStringOption((o) =>
                        o.setName("name").setDescription("Display name shown everywhere - any text").setRequired(true).setMaxLength(60),
                    ),
                true,
            ).addStringOption((o) =>
                o
                    .setName("detection_name")
                    .setDescription("Name as macros report it (letters/digits/spaces) - default: the display name")
                    .setMaxLength(60),
            ),
        )
        .addSubcommand((s) =>
            addSharedBiomeOptions(
                s
                    .setName("edit")
                    .setDescription("Changes a biome's fields - only the ones given.")
                    .addStringOption((o) => o.setName("biome").setDescription("Biome").setRequired(true).setAutocomplete(true))
                    .addStringOption((o) =>
                        o.setName("label").setDescription("New display name (the detection name never changes)").setMaxLength(60),
                    ),
                false,
            ),
        )
        .addSubcommand((s) =>
            s
                .setName("disable")
                .setDescription("Stops recognizing a biome and hides it from pickers. Old finds keep showing.")
                .addStringOption((o) => o.setName("biome").setDescription("Biome").setRequired(true).setAutocomplete(true)),
        )
        .addSubcommand((s) =>
            s
                .setName("enable")
                .setDescription("Turns a disabled biome back on.")
                .addStringOption((o) => o.setName("biome").setDescription("Biome").setRequired(true).setAutocomplete(true)),
        )
        .addSubcommand((s) => s.setName("list").setDescription("Lists every registered biome."))
        .addSubcommand((s) =>
            s.setName("export").setDescription("Downloads every biome as a JSON file - for /bh-owner biome import on another bot."),
        )
        .addSubcommand((s) =>
            s
                .setName("import")
                .setDescription("Applies a file from /bh-owner biome export - shows what changes and asks first.")
                .addAttachmentOption((o) =>
                    o.setName("file").setDescription("The .json file /bh-owner biome export made").setRequired(true),
                )
                .addStringOption((o) =>
                    o
                        .setName("mode")
                        .setDescription("What happens to biomes missing from the file (default: keep)")
                        .addChoices(
                            { name: "Keep them as they are", value: "merge" },
                            { name: "Disable them (mirror the file)", value: "mirror" },
                        ),
                ),
        );
}

/** Autocomplete for the `biome` option of `/bh-owner biome edit|disable|enable`. */
export async function respondBiomeAdminAutocomplete(interaction: AutocompleteInteraction, typed: string): Promise<void> {
    const sub = interaction.options.getSubcommand(false);
    const which = sub === "disable" ? "enabled" : sub === "enable" ? "disabled" : "all";
    await interaction.respond(biomeAutocompleteChoices(typed, { which }));
}

function ansiInputFrom(args: CommandArgs): AnsiInput {
    return { text: args.getString("ansi_text"), background: args.getString("ansi_background"), bold: args.getBoolean("ansi_bold") };
}

function biomeCard(title: string, e: BiomeEntry, notes: string[] = []): FormattedReply {
    return { components: [buildBiomeCard(title, e, notes)], flags: MessageFlags.IsComponentsV2, allowedMentions: NO_PINGS };
}

const NETWORK_NOTE = "Rare biomes are Network biomes: a server joining the Network now needs a forward for this one too.";

/** What the owner should know after a biome starts being recognized. */
function enabledNotes(e: BiomeEntry, detectionName: string): string[] {
    const notes: string[] = [];
    if (detectionName.trim().split(/\s+/).length > 2)
        notes.push("Macro text is matched on up to 2 words - a 3+ word name is only caught from the embed thumbnail's file name.");
    if (e.category === "rare") notes.push(NETWORK_NOTE);
    notes.push("Test it with `/bh-owner simulate-biome`.");
    return notes;
}

/** `/bh-owner biome <sub>` - the caller already deferred ephemerally. */
export async function runBiomeAdminSubcommand(ctx: CommandContext): Promise<void> {
    const args = ctx.args;
    switch (args.getSubcommand()) {
        case "add": {
            const detectionName = args.getString("detection_name");
            const entry = await addBiome({
                name: args.getString("name", true),
                detectionName,
                category: args.getString("category", true),
                color: args.getString("color", true),
                flavorText: args.getString("flavor_text"),
                iconUrl: args.getString("icon_url"),
                ansi: ansiInputFrom(args),
            });
            await ctx.reply(biomeCard("Biome added", entry, enabledNotes(entry, detectionName ?? entry.label)));
            return;
        }
        case "edit": {
            const entry = await editBiome({
                biome: args.getString("biome", true),
                label: args.getString("label"),
                category: args.getString("category"),
                color: args.getString("color"),
                flavorText: args.getString("flavor_text"),
                iconUrl: args.getString("icon_url"),
                ansi: ansiInputFrom(args),
            });
            await ctx.reply(biomeCard("Biome updated", entry, entry.category === "rare" && entry.enabled ? [NETWORK_NOTE] : []));
            return;
        }
        case "disable": {
            const entry = await setBiomeActive(args.getString("biome", true), false);
            await ctx.reply(
                biomeCard("Biome disabled", entry, [
                    "No longer recognized from macros nor offered in pickers. Existing forwards for it stay saved.",
                ]),
            );
            return;
        }
        case "enable": {
            const entry = await setBiomeActive(args.getString("biome", true), true);
            await ctx.reply(biomeCard("Biome enabled", entry, enabledNotes(entry, entry.key)));
            return;
        }
        case "list":
            await ctx.open(biomeListView, undefined);
            return;
        case "export":
            return runBiomeExport(ctx);
        case "import":
            return runBiomeImport(ctx);
        default:
            throw new BiomeHuntError(`Unknown subcommand: ${args.getSubcommand()}`);
    }
}

async function runBiomeExport(ctx: CommandContext): Promise<void> {
    const file = exportCurrentBiomes(ctx.client.user?.tag ?? null);
    const name = `biomes-${file.exportedAt.slice(0, 10)}.json`;
    await ctx.reply({
        content: `Exported **${file.biomes.length}** biomes. Apply them on another bot with \`/bh-owner biome import\`.`,
        files: [new AttachmentBuilder(Buffer.from(JSON.stringify(file, null, 4)), { name })],
        allowedMentions: NO_PINGS,
    });
}

/** Far above any real export (~300 bytes per biome) - only stops a wrong file from being downloaded. */
const MAX_IMPORT_BYTES = 512 * 1024;

const listOrNone = (keys: string[]) => (keys.length > 0 ? keys.join(", ") : "none");

function importFields(plan: BiomeImportPlan, mirror: boolean): Array<{ label: string; value: string }> {
    const fields = [
        { label: "Added", value: listOrNone(plan.added) },
        { label: "Updated", value: listOrNone(plan.updated.map((u) => `${u.key} (${u.fields.join(", ")})`)) },
    ];
    if (mirror) fields.push({ label: "Disabled (missing from the file)", value: listOrNone(plan.disabled) });
    fields.push({ label: "Unchanged", value: String(plan.unchanged) }, { label: "Order", value: "the file's biomes first, in its order" });
    return fields;
}

/** Slash only (see bh-owner's `subcommandModes`) - a prefix call has no attachment option to read. */
async function runBiomeImport(ctx: CommandContext): Promise<void> {
    if (ctx.raw.kind !== "slash") throw new BiomeHuntError("Import only works as a slash command.");
    const attachment = ctx.raw.interaction.options.getAttachment("file", true);
    if (attachment.size > MAX_IMPORT_BYTES) throw new BiomeHuntError("That file is too big to be a biome export.");

    const response = await fetch(attachment.url);
    if (!response.ok) throw new BiomeHuntError(`Couldn't download the file (HTTP ${response.status}).`);
    const incoming = parseBiomeConfig(await response.text());

    const mirror = ctx.args.getString("mode") === "mirror";
    const plan = planBiomeImport(getAllBiomes(), incoming, mirror);
    if (plan.added.length + plan.updated.length + plan.disabled.length === 0) {
        await ctx.reply(EmbedFormatter.info(`Nothing to change - this bot's biomes already match \`${attachment.name}\`.`));
        return;
    }

    await ctx.open(
        confirm({
            name: "biomehunt.biome-import",
            title: `Import ${incoming.length} biomes from ${attachment.name}?`,
            fields: importFields(plan, mirror),
            color: mirror ? 0xf97316 : undefined,
            onConfirm: async () => {
                await applyBiomeImport(plan);
                const changed = plan.added.length + plan.updated.length + plan.disabled.length;
                return EmbedFormatter.success(`Imported - ${changed} biome(s) changed. It applies right away.`);
            },
        }),
        undefined,
    );
}
