import type { Client, Message } from "discord.js";
import { BiomeHuntError } from "../types";

const MESSAGE_LINK = /discord(?:app)?\.com\/channels\/(?:\d+|@me)\/(\d+)\/(\d+)/;
const SNOWFLAKE = /^\d{17,20}$/;

/** Reads a message link, or a bare message id meaning `currentChannelId`. */
export function parseMessageReference(input: string, currentChannelId: string): { channelId: string; messageId: string } | null {
    const trimmed = input.trim();
    const link = trimmed.match(MESSAGE_LINK);
    if (link) return { channelId: link[1], messageId: link[2] };
    return SNOWFLAKE.test(trimmed) ? { channelId: currentChannelId, messageId: trimmed } : null;
}

export async function fetchReferencedMessage(client: Client, input: string, currentChannelId: string): Promise<Message> {
    const reference = parseMessageReference(input, currentChannelId);
    if (!reference) throw new BiomeHuntError("Give a message link, or the ID of a message in this channel.");

    const channel = await client.channels.fetch(reference.channelId).catch(() => null);
    const message = channel?.isTextBased() ? await channel.messages.fetch(reference.messageId).catch(() => null) : null;
    if (!message) throw new BiomeHuntError("I can't read that message.");
    return message;
}
