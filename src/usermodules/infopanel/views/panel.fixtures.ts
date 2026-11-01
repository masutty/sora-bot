import type { OptionRow, PanelRow } from "../types";

/** Test-only rows. */
export const panel = (overrides: Partial<PanelRow> = {}): PanelRow => ({
    id: 7,
    guild_id: "g1",
    name: "Server rules",
    placeholder: "Pick a category",
    blocks: [
        { t: "title", v: "Server rules" },
        { t: "text", v: "Read them." },
        { t: "sep" },
        { t: "img", url: "https://i.imgur.com/a.png" },
    ],
    channel_id: null,
    message_id: null,
    ...overrides,
});

export const option = (id: number, label: string, overrides: Partial<OptionRow> = {}): OptionRow => ({
    id,
    panel_id: 7,
    position: id,
    label,
    emoji: null,
    description: null,
    blocks: [{ t: "title", v: label }],
    ...overrides,
});
