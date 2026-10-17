import { ButtonStyle, ContainerBuilder, MessageFlags, SeparatorSpacingSize } from "discord.js";
import type { HandlerContext, RenderKit } from "@/core/view/view";
import { defineView, type ViewDefinition, type ViewPayload } from "@/define";
import { formatCodeblock, formatTime, NO_PINGS } from "@/utils/format";
import { DEFAULT_BADGE_EMOJI } from "../constants/badges.constants";
import {
    ALL_BIOME_CATEGORIES,
    ANSI_BACKGROUND_COLORS,
    ANSI_TEXT_COLORS,
    type AnsiColorOption,
    BIOME_CATEGORY_LABELS,
    type BiomeEntry,
    describeAnsiColor,
    getAllBiomes,
    getBiomeMeta,
    MAX_DISCORD_CHOICES,
    parseAnsiCode,
} from "../constants/biomes.constants";
import {
    type BiomeAdminDeps,
    CLEAR_VALUE,
    defaultBiomeAdminDeps,
    type EditBiomeInput,
    editBiome,
    formatDurationInput,
    formatHexColor,
    NO_BIOME_CHANGES,
    setBiomeActive,
} from "../services/biome-admin.service";
import { type BiomeCategory, BiomeHuntError } from "../types";

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
    const durationWidth = Math.max(...biomes.map((e) => (e.durationS ? formatTime(e.durationS).replace(/ /g, "").length : 1)));
    const lines = biomes.map((e) => {
        const label = fit(e.label, labelWidth);
        const rest = [
            e.key.padEnd(keyWidth),
            formatHexColor(e.color),
            (e.durationS ? formatTime(e.durationS).replace(/ /g, "") : "-").padEnd(durationWidth),
            e.enabled ? `${e.iconUrl ? "icon" : "-   "} ${e.flavorText ? "flavor" : "-     "}` : "disabled",
            // Last on the line - an emoji's width varies, so nothing after it would line up.
            ...(e.hasBadge ? [e.badgeEmoji || DEFAULT_BADGE_EMOJI] : []),
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
        `Duration: ${e.durationS ? formatTime(e.durationS) : "none"}`,
        `Badge: ${e.hasBadge ? e.badgeEmoji || DEFAULT_BADGE_EMOJI : "none"}`,
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
        td.setContent(
            `### Biomes · ${enabled} enabled · ${all.length - enabled} disabled\n-# Display name · detection name · color · duration`,
        ),
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

type ListContext = HandlerContext<BiomeListState, void>;

const colorOptions = (colors: readonly AnsiColorOption[], current: number | null) => [
    { label: "None", value: CLEAR_VALUE, default: current === null },
    ...colors.map((c) => ({ label: c.name, value: c.slug, default: c.code === current })),
];

/** The open card's editing controls: selects for the fixed-choice fields, buttons for the rest (forms and toggles). */
function editorRows(e: BiomeEntry, kit: RenderKit) {
    const style = parseAnsiCode(e.ansiColor);
    const toggle = (on: boolean) => (on ? ButtonStyle.Primary : ButtonStyle.Secondary);
    return [
        kit.row(
            kit.stringSelect("edit:category", (s) =>
                s.addOptions(
                    ALL_BIOME_CATEGORIES.map((c) => ({
                        label: `Category: ${BIOME_CATEGORY_LABELS[c]}`,
                        value: c,
                        default: c === e.category,
                    })),
                ),
            ),
        ),
        kit.row(
            kit.stringSelect("edit:ansi-text", (s) =>
                s.addOptions(colorOptions(ANSI_TEXT_COLORS, style.text).map((o) => ({ ...o, label: `Text color: ${o.label}` }))),
            ),
        ),
        kit.row(
            kit.stringSelect("edit:ansi-background", (s) =>
                s.addOptions(
                    colorOptions(ANSI_BACKGROUND_COLORS, style.background).map((o) => ({ ...o, label: `Background: ${o.label}` })),
                ),
            ),
        ),
        kit.row(
            kit.button("edit:details", (b) => b.setLabel("Edit details").setStyle(ButtonStyle.Primary)),
            kit.button("edit:badge-emoji", (b) => b.setLabel("Badge emoji")),
            kit.button("edit:bold", (b) => b.setLabel(`Bold: ${style.bold ? "on" : "off"}`).setStyle(toggle(style.bold))),
            kit.button("edit:badge", (b) => b.setLabel(`Badge: ${e.hasBadge ? "on" : "off"}`).setStyle(toggle(e.hasBadge === true))),
        ),
        kit.row(
            kit.button("edit:enabled", (b) =>
                b.setLabel(e.enabled ? "Disable" : "Enable").setStyle(e.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
            ),
            kit.button("back", (b) => b.setLabel("Back")),
        ),
    ];
}

/**
 * `/bh-owner biome list`: every registered biome as one `ansi` table per category, plus a category
 * select then a biome select (two steps, so no select passes Discord's 25 options) that opens that
 * biome's full card, with Back to the table. The card edits the biome in place - every change goes
 * through `/bh-owner biome edit`'s own validation (a bad value is answered privately and changes
 * nothing). Always reads the live registry.
 */
export function biomeListView(deps: BiomeAdminDeps = defaultBiomeAdminDeps()): ViewDefinition<BiomeListState, void, void> {
    /** Applies one change to the open biome; a validation error is shown only to the clicker. */
    async function edit(c: ListContext, change: Partial<Omit<EditBiomeInput, "biome">>): Promise<void> {
        if (!c.state.selected) return;
        try {
            await editBiome({ ...NO_BIOME_CHANGES, ...change, biome: c.state.selected }, deps);
        } catch (err) {
            if (!(err instanceof BiomeHuntError)) throw err;
            await c.notify(err.message);
        }
    }

    const selectedEntry = (c: ListContext) => (c.state.selected ? getBiomeMeta(c.state.selected) : undefined);
    /** A blank form field means "remove it". */
    const orClear = (v: string | undefined) => (v?.trim() ? v : CLEAR_VALUE);

    return defineView<BiomeListState, void, void>({
        name: "biomehunt.biome-list",
        initial: () => ({ category: null, selected: null }),
        render: (state, kit): ViewPayload => {
            const selected = state.selected ? getBiomeMeta(state.selected) : undefined;
            if (selected) {
                return {
                    flags: MessageFlags.IsComponentsV2,
                    components: [buildBiomeCard(selected.label, selected), ...editorRows(selected, kit)],
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
            "edit:category": (c) => edit(c, { category: c.values[0] }),
            "edit:ansi-text": (c) => edit(c, { ansi: { ...NO_BIOME_CHANGES.ansi, text: c.values[0] } }),
            "edit:ansi-background": (c) => edit(c, { ansi: { ...NO_BIOME_CHANGES.ansi, background: c.values[0] } }),
            "edit:bold": (c) => edit(c, { ansi: { ...NO_BIOME_CHANGES.ansi, bold: !parseAnsiCode(selectedEntry(c)?.ansiColor).bold } }),
            "edit:badge": (c) => edit(c, { hasBadge: selectedEntry(c)?.hasBadge !== true }),
            "edit:enabled": async (c) => {
                const e = selectedEntry(c);
                if (e) await setBiomeActive(e.key, !e.enabled, deps);
            },
            "edit:details": async (c) => {
                const e = selectedEntry(c);
                if (!e) return;
                const values = await c.modal({
                    title: `Edit ${e.label}`.slice(0, 45),
                    fields: [
                        { key: "label", label: "Display name", value: e.label, required: true, maxLength: 60 },
                        { key: "color", label: "Color (6 hex digits, no #)", value: formatHexColor(e.color), required: true, maxLength: 6 },
                        { key: "flavor", label: "Flavor text (blank = none)", value: e.flavorText || undefined, required: false },
                        { key: "icon", label: "Icon URL, https:// (blank = none)", value: e.iconUrl || undefined, required: false },
                        {
                            key: "duration",
                            label: "Duration, e.g. 10m or 1h30m (blank = none)",
                            value: e.durationS ? formatDurationInput(e.durationS) : undefined,
                            required: false,
                        },
                    ],
                });
                if (!values) return;
                await edit(c, {
                    label: values.label,
                    color: values.color,
                    flavorText: orClear(values.flavor),
                    iconUrl: orClear(values.icon),
                    duration: orClear(values.duration),
                });
            },
            "edit:badge-emoji": async (c) => {
                const e = selectedEntry(c);
                if (!e) return;
                const values = await c.modal({
                    title: `${e.label} badge emoji`.slice(0, 45),
                    fields: [
                        { key: "emoji", label: "Emoji or <:name:id> (blank = default)", value: e.badgeEmoji || undefined, required: false },
                    ],
                });
                if (values) await edit(c, { badgeEmoji: orClear(values.emoji) });
            },
        },
    });
}
