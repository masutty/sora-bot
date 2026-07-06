import type { Message } from "discord.js";
import { transaction } from "@/database/connection";
import { Logger } from "@/utils/logging";
import { getOrCreateGuildConfig } from "../repository/guilds";
import { getUserById, lookupChannel, touchLastActivity } from "../repository/users";
import { extendSession, getLatestSession, insertEventIfNew, openNewSession } from "../repository/activity";
import { parseEvent } from "../webhookParser";
import { checkAndAwardBadge } from "./BadgeEngine";
import { checkAndForward } from "./ForwardEngine";
import { transitionUser } from "../workers/StatusEngine";

const logger = new Logger("biomehunt.ActivityEngine");

export async function processIncomingMessage(message: Message): Promise<void> {
    const entry = lookupChannel(message.channelId);
    if (!entry) return;

    if (!message.webhookId || message.webhookId !== entry.webhookId) {
        logger.warn(`Rejected message in tracked channel ${message.channelId}: webhook id mismatch`);
        return;
    }

    const parsed = parseEvent(message);
    if (!parsed) {
        logger.debug(`No biome event parsed for message ${message.id}`);
        return;
    }

    const now = new Date();

    const inserted = await transaction((client) =>
        insertEventIfNew(client, entry.userId, message.id, parsed.biome, parsed.macroType, parsed.eventType, parsed.eventTimestamp),
    );
    if (!inserted) return;

    await checkAndAwardBadge(entry.guildId, entry.userId, parsed.biome, parsed.eventType);

    const user = await getUserById(entry.userId);
    if (!user) return;

    logger.debug(`checkAndForward: ${entry.guildId} ${user.discord_user_id} :: Parsed -> ${JSON.stringify(parsed)}`);
    await checkAndForward(message, entry.guildId, parsed);

    const guildConfig = await getOrCreateGuildConfig(entry.guildId);
    const deltaSeconds = user.last_activity_at
        ? (now.getTime() - user.last_activity_at.getTime()) / 1000
        : Number.POSITIVE_INFINITY;

    await transaction(async (client) => {
        if (deltaSeconds > guildConfig.session_gap_threshold_s) {
            await openNewSession(client, entry.userId, now);
        } else {
            const latest = await getLatestSession(client, entry.userId);
            if (latest) await extendSession(client, latest.id, now);
            else await openNewSession(client, entry.userId, now);
        }
    });

    await touchLastActivity(entry.userId, now);

    if (user.current_status !== "active") {
        await transitionUser(entry.userId, entry.guildId, "active");
    }
}
