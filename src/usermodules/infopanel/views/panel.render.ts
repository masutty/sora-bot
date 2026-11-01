import {
    ActionRowBuilder,
    ContainerBuilder,
    type MessageActionRowComponentBuilder,
    type MessageMentionOptions,
    SeparatorSpacingSize,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
} from "discord.js";
import { NO_PINGS } from "@/utils/format";
import { settings } from "../settings";
import type { Block, OptionRow, PanelRow } from "../types";

/** The customId prefix of both selects (`infopanel:pick:<panelId>:<root|eph>`). Starts with the cog's name. */
export const PICK_PREFIX = "infopanel:pick";

export type PickSource = "root" | "eph";

export const pickCustomId = (panelId: number, source: PickSource) => `${PICK_PREFIX}:${panelId}:${source}`;

/** What a published message or an option page carries; the caller adds the message flags. */
export interface PagePayload {
    components: ContainerBuilder[];
    allowedMentions: MessageMentionOptions;
}

/** Adds the blocks to the container. An empty page still gets `fallback`, since a container can't be empty. */
export function addBlocks(container: ContainerBuilder, blocks: Block[], fallback: string): void {
    if (blocks.length === 0) {
        container.addTextDisplayComponents((td) => td.setContent(fallback));
        return;
    }
    for (const block of blocks) {
        if (block.t === "title") container.addTextDisplayComponents((td) => td.setContent(`## ${block.v}`));
        else if (block.t === "text") container.addTextDisplayComponents((td) => td.setContent(block.v));
        else if (block.t === "sep") container.addSeparatorComponents((s) => s.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
        else container.addMediaGalleryComponents((g) => g.addItems((i) => i.setURL(block.url)));
    }
}

/** The select over `options` (value = option id), or null when there is nothing to pick - Discord rejects an empty select. */
export function pickSelect(
    panel: PanelRow,
    options: OptionRow[],
    source: PickSource,
    disabled = false,
): ActionRowBuilder<StringSelectMenuBuilder> | null {
    if (options.length === 0) return null;
    const select = new StringSelectMenuBuilder()
        .setCustomId(pickCustomId(panel.id, source))
        .setPlaceholder(panel.placeholder)
        .setDisabled(disabled)
        .addOptions(
            options.slice(0, 25).map((o) => {
                const option = new StringSelectMenuOptionBuilder().setLabel(o.label).setValue(String(o.id));
                if (o.description) option.setDescription(o.description);
                if (o.emoji) option.setEmoji(o.emoji);
                return option;
            }),
        );
    return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

function page(panel: PanelRow, blocks: Block[], fallback: string, options: OptionRow[], source: PickSource, disabled = false): PagePayload {
    const container = new ContainerBuilder().setAccentColor(settings.accentColor);
    addBlocks(container, blocks, fallback);
    const row = pickSelect(panel, options, source, disabled);
    if (row) container.addActionRowComponents(row as unknown as ActionRowBuilder<MessageActionRowComponentBuilder>);
    return { components: [container], allowedMentions: NO_PINGS };
}

/** The message posted in the channel: the root page and the select over every option. */
export const buildRootPage = (panel: PanelRow, options: OptionRow[]): PagePayload =>
    page(panel, panel.blocks, `## ${panel.name}`, options, "root");

/** The page a member sees after picking `option`: its blocks and the select over the OTHER options. */
export function buildOptionPage(panel: PanelRow, options: OptionRow[], option: OptionRow): PagePayload {
    return page(
        panel,
        option.blocks,
        `## ${option.label}`,
        options.filter((o) => o.id !== option.id),
        "eph",
    );
}

/** The editor's preview of a page: what members see, with the select switched off. `options` is every option of the panel. */
export function buildPreview(panel: PanelRow, options: OptionRow[], target: OptionRow | null): PagePayload {
    if (target) {
        return page(
            panel,
            target.blocks,
            `## ${target.label}`,
            options.filter((o) => o.id !== target.id),
            "eph",
            true,
        );
    }
    return page(panel, panel.blocks, `## ${panel.name}`, options, "root", true);
}
