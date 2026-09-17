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
    error: (msg: string, options?: FormattedReplyOptions) => statusReply(0xff0000, "❌", msg, options),
    success: (msg: string, options?: FormattedReplyOptions) => statusReply(0x57f287, "✅", msg, options),
    info: (msg: string, options?: FormattedReplyOptions) => statusReply(0x5865f2, "ℹ️", msg, options),
    warn: (msg: string, options?: FormattedReplyOptions) => statusReply(0xffff00, "⚠️", msg, options),
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
