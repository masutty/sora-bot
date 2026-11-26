import type { Message } from "discord.js";
import { settings } from "../settings";

export type CaptureResult = { ok: true; content: string } | { ok: false; reason: string };

/** Accepts only plain text. Content is kept raw so markdown and mentions survive. */
export function validateCapture(
    message: Pick<Message, "content" | "attachments" | "stickers" | "poll" | "messageSnapshots">,
): CaptureResult {
    if (message.attachments.size > 0) return { ok: false, reason: "Stickies are text only, so send it again without attachments." };
    if (message.stickers.size > 0 || message.poll || message.messageSnapshots.size > 0) {
        return { ok: false, reason: "Stickies are text only." };
    }
    if (message.content.trim() === "") return { ok: false, reason: "Send some text." };
    if (message.content.length > settings.maxContent) return { ok: false, reason: `Keep it under ${settings.maxContent} characters.` };
    return { ok: true, content: message.content };
}
