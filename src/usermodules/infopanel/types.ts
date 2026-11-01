/** One piece of a page: a heading, free text, a divider or an image. */
export type Block = { t: "title"; v: string } | { t: "text"; v: string } | { t: "sep" } | { t: "img"; url: string };

/** A panel: its root page (`blocks`, `placeholder`) plus where it is posted. */
export interface PanelRow {
    id: number;
    guild_id: string;
    name: string;
    /** The select's placeholder, on the root and on every option page. */
    placeholder: string;
    blocks: Block[];
    channel_id: string | null;
    message_id: string | null;
}

/** An option of a panel: one entry of the select, and the page it shows. */
export interface OptionRow {
    id: number;
    panel_id: number;
    position: number;
    label: string;
    emoji: string | null;
    description: string | null;
    blocks: Block[];
}
