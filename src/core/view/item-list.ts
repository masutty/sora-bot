import { type ButtonBuilder, type ContainerBuilder, SeparatorSpacingSize } from "discord.js";

/** One row of an item list: bold-ready text with a small button on the right and an optional note below at full width. */
export interface Item {
    /** Markdown for the Section next to the button, e.g. `**Warn expiry:** 30 days`. */
    text: string;
    /** The Section's accessory. */
    button: ButtonBuilder;
    /** Full-width text under the Section, e.g. a `-#` subtext line. */
    note?: string;
}

/** A small divider line. */
export function addDivider(container: ContainerBuilder): ContainerBuilder {
    return container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
}

/** Options for {@link addItems}. */
export interface ItemListOptions {
    /** Put a small divider between items (default true). Pass false to keep a group compact. */
    dividers?: boolean;
    /**
     * Put each note in the Section, right under its text and beside the button, instead of full width
     * below it (default false). Keeps a short note visually tied to its title.
     */
    notesBeside?: boolean;
}

/**
 * Adds `items` to `container`: each a Section (text + inline button accessory) with its optional note below,
 * and by default a small divider between items (none before the first or after the last).
 *
 * @example
 * addItems(box, [{ text: "**Case Channel:** none", button: kit.button("channel", (b) => b.setLabel("Change")) }]);
 */
export function addItems(container: ContainerBuilder, items: Item[], options: ItemListOptions = {}): ContainerBuilder {
    const { dividers = true, notesBeside = false } = options;
    items.forEach((item, i) => {
        if (dividers && i > 0) addDivider(container);
        const beside = notesBeside && item.note !== undefined;
        const text = beside ? `${item.text}\n${item.note}` : item.text;
        container.addSectionComponents((section) =>
            section.addTextDisplayComponents((td) => td.setContent(text)).setButtonAccessory(item.button),
        );
        if (item.note !== undefined && !beside) container.addTextDisplayComponents((td) => td.setContent(item.note as string));
    });
    return container;
}
