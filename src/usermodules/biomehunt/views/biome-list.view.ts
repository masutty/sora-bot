import { ButtonStyle, ContainerBuilder, MessageFlags, SeparatorSpacingSize } from "discord.js";
import { defineView, type ViewDefinition, type ViewPayload } from "@/define";
import { formatCodeblock, NO_PINGS } from "@/utils/format";
import {
    ALL_BIOME_CATEGORIES,
    BIOME_CATEGORY_LABELS,
    type BiomeEntry,
    describeAnsiColor,
    getAllBiomes,
    getBiomeMeta,
    MAX_DISCORD_CHOICES,
} from "../constants/biomes.constants";
import { formatHexColor } from "../services/biome-admin.service";
import type { BiomeCategory } from "../types";

const ANSI_RESET = "\u001b[0m";
/** Gray (SGR 30) - how a disabled biome's row reads in the table, whatever its own color. */
const ANSI_DISABLED = "\u001b[30m";
/** Longer display names are cut in the table so the columns stay on one line on mobile. */
const MAX_LABEL_COLUMN = 18;
const LIST_ACCENT = 0x5865f2;

function fit(text: string, width: number): string {
    return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);
}

/**
 * One category's biomes as an `ansi` table - display name in its own ANSI style (exactly how
 * /bh profile shows it), detection name, color, and whether it has an icon/flavor text. A disabled
 * row is all gray. Padding is applied to the raw text, outside the escape codes, so columns align.
 */
export function buildCategoryTable(biomes: BiomeEntry[]): string {
    const labelWidth = Math.min(MAX_LABEL_COLUMN, Math.max(...biomes.map((e) => e.label.length)));
    const keyWidth = Math.max(...biomes.map((e) => e.key.length));
    const lines = biomes.map((e) => {
        const label = fit(e.label, labelWidth);
        const rest = [
            e.key.padEnd(keyWidth),
            formatHexColor(e.color),
            e.enabled ? `${e.iconUrl ? "icon" : "-   "} ${e.flavorText ? "flavor" : "-"}` : "disabled",
        ].join("  ");
        return e.enabled ? `${e.ansiColor ?? ""}${label}${ANSI_RESET}  ${rest}` : `${ANSI_DISABLED}${label}  ${rest}${ANSI_RESET}`;
    });
    return formatCodeblock(lines.join("\n"), "ansi");
}

function describeBiome(e: BiomeEntry): string {
    return [
        `**${e.label}** - ${BIOME_CATEGORY_LABELS[e.category]}${e.enabled ? "" : " - **disabled**"}`,
        `Detection name: \`${e.key}\``,
        `Color: \`${formatHexColor(e.color)}\``,
        `Flavor text: ${e.flavorText ? `*${e.flavorText}*` : "none"}`,
        `Icon: ${e.iconUrl || "none"}`,
        `ANSI: ${describeAnsiColor(e.ansiColor)}`,
        formatCodeblock(`${e.ansiColor ?? ""}${e.label}${ANSI_RESET}: 12`, "ansi"),
    ].join("\n");
}

/** A biome's full card - every field, its icon as the thumbnail, its color as the accent and an ANSI preview. */
export function buildBiomeCard(title: string, e: BiomeEntry, notes: string[] = []): ContainerBuilder {
    const container = new ContainerBuilder().setAccentColor(e.color);
    const content = `### ${title}\n${describeBiome(e)}`;
    if (e.iconUrl) {
        container.addSectionComponents((section) =>
            section
                .addTextDisplayComponents((td) => td.setContent(content))
                .setThumbnailAccessory((thumb) => thumb.setURL(e.iconUrl as string)),
        );
    } else {
        container.addTextDisplayComponents((td) => td.setContent(content));
    }
    if (notes.length > 0) container.addTextDisplayComponents((td) => td.setContent(notes.map((n) => `-# ${n}`).join("\n")));
    return container;
}

function buildListContainer(): ContainerBuilder {
    const all = getAllBiomes();
    const enabled = all.filter((e) => e.enabled).length;
    const container = new ContainerBuilder().setAccentColor(LIST_ACCENT);
    container.addTextDisplayComponents((td) =>
        td.setContent(`### Biomes · ${enabled} enabled · ${all.length - enabled} disabled\n-# Display name · detection name · color`),
    );
    for (const category of ALL_BIOME_CATEGORIES) {
        const biomes = all.filter((e) => e.category === category);
        if (biomes.length === 0) continue;
        container.addSeparatorComponents((sep) => sep.setDivider(false).setSpacing(SeparatorSpacingSize.Small));
        container.addTextDisplayComponents((td) =>
            td.setContent(`**${BIOME_CATEGORY_LABELS[category]} (${biomes.length})**\n${buildCategoryTable(biomes)}`),
        );
    }
    return container;
}

interface BiomeListState {
    /** The category whose biomes the second select lists. */
    category: BiomeCategory | null;
    /** The biome whose card is open - `null` = the table. */
    selected: string | null;
}

/**
 * `/bh-owner biome list`: every registered biome as one `ansi` table per category, plus a category
 * select then a biome select (two steps, so no select passes Discord's 25 options) that opens that
 * biome's full card, with Back to the table. Always reads the live registry.
 */
export const biomeListView: ViewDefinition<BiomeListState, void, void> = defineView<BiomeListState, void, void>({
    name: "biomehunt.biome-list",
    initial: () => ({ category: null, selected: null }),
    render: (state, kit): ViewPayload => {
        const selected = state.selected ? getBiomeMeta(state.selected) : undefined;
        if (selected) {
            return {
                flags: MessageFlags.IsComponentsV2,
                components: [
                    buildBiomeCard(selected.label, selected),
                    kit.row(kit.button("back", (b) => b.setLabel("Back").setStyle(ButtonStyle.Secondary))),
                ],
                allowedMentions: NO_PINGS,
            };
        }

        const categories = ALL_BIOME_CATEGORIES.filter((c) => getAllBiomes().some((e) => e.category === c));
        const categoryMenu = kit.stringSelect("category", (s) =>
            s
                .setPlaceholder("Inspect a biome - pick its category")
                .addOptions(categories.map((c) => ({ label: BIOME_CATEGORY_LABELS[c], value: c, default: c === state.category }))),
        );
        const category = state.category;
        const biomeMenu = category
            ? kit.stringSelect("biome", (s) =>
                  s.setPlaceholder(`Pick a ${BIOME_CATEGORY_LABELS[category]} biome`).addOptions(
                      getAllBiomes()
                          .filter((e) => e.category === category)
                          .slice(0, MAX_DISCORD_CHOICES)
                          .map((e) => ({ label: e.label, value: e.key, description: e.enabled ? e.key : `${e.key} · disabled` })),
                  ),
              )
            : null;

        return {
            flags: MessageFlags.IsComponentsV2,
            components: [buildListContainer(), kit.row(categoryMenu), ...(biomeMenu ? [kit.row(biomeMenu)] : [])],
            allowedMentions: NO_PINGS,
        };
    },
    on: {
        category: (c) => {
            c.state.category = c.values[0] as BiomeCategory;
        },
        biome: (c) => {
            c.state.selected = c.values[0];
        },
        back: (c) => {
            c.state.selected = null;
        },
    },
});
