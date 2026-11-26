import type { Message } from "discord.js";
import { Logger } from "@/utils/logging";
import { inspectMessage, isMerchantReport } from "../macro-parsers";
import type { ChannelIndexEntry } from "../repository/users.repository";

const logger = new Logger("biomehunt.services.macro-warning-log");

/** Macro messages written to the log with a warning - enough to see what the streak looked like. */
const SNAPSHOT_SIZE = 15;

export interface MacroWarningContext {
    entry: ChannelIndexEntry;
    memberId: string;
    macro: string | null;
}

/**
 * Writes who was warned and what their macro was sending. Every line carries the current trace, so
 * `/bot trace <ref>` with the ref on the warning returns all of it.
 */
export async function logMacroWarning(message: Message, { entry, memberId, macro }: MacroWarningContext): Promise<void> {
    logger.info("Macro warning", {
        discordUserId: memberId,
        userId: entry.userId,
        guildId: entry.guildId,
        channelId: message.channelId,
        webhookId: entry.webhookId,
        macro: macro ?? "unknown",
    });

    const recent = await message.channel.messages.fetch({ limit: SNAPSHOT_SIZE });
    for (const received of [...recent.values()].reverse()) {
        if (received.webhookId !== entry.webhookId) continue;
        const { parserId, event } = inspectMessage(received);
        logger.info(
            `Received ${received.url} at ${received.createdAt.toISOString()}: parser=${parserId ?? "none"} ` +
                `biome=${event?.biome ?? "none"} event=${event?.eventType ?? "none"} merchant=${isMerchantReport(received)}`,
            { embeds: received.embeds.map((e) => e.toJSON()), components: received.components.map((c) => c.toJSON()) },
        );
    }
}
