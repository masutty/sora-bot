import type { Client, Message } from "discord.js";
import { BiomeHuntError } from "../types";

const MESSAGE_LINK = /discord(?:app)?\.com\/channels\/(?:\d+|@me)\/(\d+)\/(\d+)/;
const SNOWFLAKE = /^\d{17,20}$/;

export interface MessageTarget {
    channelId: string;
    messageId: string;
}

/** Reads a message link, or a bare message id meaning `currentChannelId`. */
export function parseMessageReference(input: string, currentChannelId: string): MessageTarget | null {
    const trimmed = input.trim();
    const link = trimmed.match(MESSAGE_LINK);
    if (link) return { channelId: link[1], messageId: link[2] };
    return SNOWFLAKE.test(trimmed) ? { channelId: currentChannelId, messageId: trimmed } : null;
}

/** The message a command points at: what was typed, or - with nothing typed - the one it replies to. */
export async function fetchReferencedMessage(
    client: Client,
    input: string | null,
    currentChannelId: string,
    replied: MessageTarget | null = null,
): Promise<Message> {
    const reference = input ? parseMessageReference(input, currentChannelId) : replied;
    if (!reference) throw new BiomeHuntError("Reply to a message, or give its link or its ID if it's in this channel.");

    const channel = await client.channels.fetch(reference.channelId).catch(() => null);
    const message = channel?.isTextBased() ? await channel.messages.fetch(reference.messageId).catch(() => null) : null;
    if (!message) throw new BiomeHuntError("I can't read that message.");
    return message;
}
