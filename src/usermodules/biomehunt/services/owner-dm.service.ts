import type { Client, MessageCreateOptions } from "discord.js";
import { config } from "@/config";
import { Logger } from "@/utils/logging";

const logger = new Logger("biomehunt.services.owner-dm");

/**
 * DMs every bot owner (`OWNER_IDS`) - the Network has no central admin server, so join requests
 * and alerts land here. A failed DM (closed DMs, no shared server) is logged and skipped, never
 * thrown: whatever the DM reports is already recorded in the database.
 */
export async function notifyOwners(
    client: Client,
    payload: MessageCreateOptions,
    ownerIds: readonly string[] = config.bot.ownerIds,
): Promise<void> {
    for (const ownerId of ownerIds) {
        try {
            const user = await client.users.fetch(ownerId);
            await user.send(payload);
        } catch (err) {
            logger.warn(`Could not DM bot owner ${ownerId}`, { error: err instanceof Error ? err.message : String(err) });
        }
    }
}
