import type { Message } from "discord.js";

/** Downloads a message's first attachment as text - `null` if there's no attachment. */
export async function fetchAttachmentText(msg: Message): Promise<string | null> {
    const attachment = msg.attachments.first();
    if (!attachment) return null;

    const res = await fetch(attachment.url);
    if (!res.ok) throw new Error(`Failed to download the attachment (HTTP ${res.status}).`);
    return res.text();
}

/**
 * Resolves where a "paste it here or attach a file" prefix command's text payload comes from:
 * the message's own attachment first, then its own text (with `prefixPattern` already stripped),
 * then - if neither - the replied-to message (its attachment, or its text), in the same order.
 */
export async function resolveMessageSource(message: Message, prefixPattern: RegExp): Promise<string> {
    const ownAttachment = await fetchAttachmentText(message);
    if (ownAttachment !== null) return ownAttachment;

    const ownText = message.content.replace(prefixPattern, "").trim();
    if (ownText) return ownText;

    if (!message.reference?.messageId) return "";
    const replied = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
    if (!replied) return "";

    const repliedAttachment = await fetchAttachmentText(replied);
    if (repliedAttachment !== null) return repliedAttachment;

    return replied.content.replace(prefixPattern, "").trim();
}
