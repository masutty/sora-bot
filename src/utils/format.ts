import { ContainerBuilder, MessageFlags } from "discord.js";

export function formatTime(seconds: number): string {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);

    return [d && `${d}d`, h && `${h}h`, m && `${m}m`, s && `${s}s`]
        .filter(Boolean)
        .join(" ") || "?s";
}

export function formatCodeblock(code: string, language: string = "txt"): string {
    return `\`\`\`${language}\n${code}\n\`\`\``;
}

/** Unix seconds for a Date, for use in Discord timestamp tags (`<t:...:F>` etc). */
export function unix(date: Date): number {
    return Math.floor(date.getTime() / 1000);
}

/**
 * Undoes a markdown code fence, if the WHOLE text is wrapped in one - returns it raw otherwise.
 * Only looks at the outer edge (start/end of the text), not the first/next ``` that shows up, so
 * it doesn't get confused when the content itself has a code block embedded in it (e.g. a JSON
 * whose field value is `"```txt\n...\n```"`, which a "non-greedy" regex would cut at the wrong spot).
 */
export function extractCodeBlock(text: string): string {
    const trimmed = text.trim();
    if (!trimmed.startsWith("```")) return trimmed;

    const withoutOpenFence = trimmed.replace(/^```\w*\n?/, "");
    const closeIdx = withoutOpenFence.lastIndexOf("```");
    return (closeIdx === -1 ? withoutOpenFence : withoutOpenFence.slice(0, closeIdx)).trim();
}

/** Already the whole reply/send payload - `await message.reply(EmbedFormatter.error(msg))`, no need to wrap in `{ embeds: [...] }`. */
export interface FormattedReply {
    components: ContainerBuilder[];
    flags: MessageFlags.IsComponentsV2;
}

export interface FormattedReplyOptions {
    /** Type emoji on its own line, above the message. Default: `true`. */
    emoji?: boolean;
}

function statusReply(
    accent: number | undefined,
    emoji: string | null,
    msg: string,
    { emoji: showEmoji = true }: FormattedReplyOptions = {},
): FormattedReply {
    const container = new ContainerBuilder();
    if (accent !== undefined) container.setAccentColor(accent);
    if (emoji && showEmoji) container.addTextDisplayComponents((td) => td.setContent(`-# ${emoji}`));
    container.addTextDisplayComponents((td) => td.setContent(msg));
    return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

export const EmbedFormatter = {
    error: (msg: string, options?: FormattedReplyOptions) => statusReply(0xF43F5E, "❌", msg, options), // rose-500
    success: (msg: string, options?: FormattedReplyOptions) => statusReply(0x10B981, "✅", msg, options), // emerald-500
    info: (msg: string, options?: FormattedReplyOptions) => statusReply(0x0EA5E9, "ℹ️", msg, options), // sky-500
    warn: (msg: string, options?: FormattedReplyOptions) => statusReply(0xEAB308, "⚠️", msg, options), // yellow-500
    /** No color, no emoji - for plain reading (a listing, a queried value), when labeling as
     * success/error/warning/info doesn't make sense. */
    plain: (msg: string): FormattedReply => statusReply(undefined, null, msg),
};

export function roleMention(id: string): string {
    return `<@&${id}>`;
}

export function channelMention(id: string): string {
    return `<#${id}>`;
}

export function userMention(id: string): string {
    return `<@${id}>`;
}
