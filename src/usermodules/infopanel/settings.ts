/** Panel builder limits - most come straight from Discord (select options, components per message, text length). */
export const settings = {
    /** A string select takes 25; the editor's page picker adds the root to the list. */
    maxOptions: 24,
    maxPanelsPerGuild: 25,
    /** Rows per page on the Panels and Options screens (a Components V2 message holds 40 components). */
    listPerPage: 5,
    maxBlocks: 10,
    /** Each image is two components (gallery + item); with 10 blocks the editor still fits the 40. */
    maxImages: 2,
    maxPanelName: 100,
    maxLabel: 100,
    maxDescription: 100,
    maxPlaceholder: 100,
    maxTitle: 100,
    maxTextBlock: 1500,
    /** All title and text of one page; the editor message shares Discord's 4000 with its own labels. */
    maxPageChars: 3000,
    maxUrl: 512,
    defaultPlaceholder: "Pick an option",
    accentColor: 0x5865f2,
} as const;
