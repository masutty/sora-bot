import type { APIMessageComponentEmoji } from "discord.js";

/**
 * The Real/Fake vote button icons: outlined while a vote is undecided, filled once it is decided
 * (both filled = tied). Custom emojis of the bot's emoji server - prod and dev may use different
 * applications, so swap the ids here if a button renders as a blank square.
 */
export const VOTE_EMOJIS = {
    realOutline: { id: "1566529802599661588", name: "check_unfilled" },
    realFilled: { id: "1566529778859909200", name: "check_filled" },
    fakeOutline: { id: "1566529845066731580", name: "x_unfilled" },
    fakeFilled: { id: "1566529822665085139", name: "x_filled" },
} as const satisfies Record<string, APIMessageComponentEmoji>;

/** An emoji of `VOTE_EMOJIS` as inline message markdown - `<:check_filled:id>`. */
export function emojiMarkdown(emoji: { id: string; name: string }): string {
    return `<:${emoji.name}:${emoji.id}>`;
}
