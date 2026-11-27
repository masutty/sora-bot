import type { Message } from "discord.js";
import { merchantTarget } from "../constants/merchants.constants";
import { type InsertMerchantEventParams, insertMerchantEventIfNew } from "../repository/merchant-events.repository";
import { settings } from "../settings";
import { checkAndForward } from "./forward.service";

export interface MerchantDeps {
    insertMerchantEventIfNew: typeof insertMerchantEventIfNew;
    checkAndForward: typeof checkAndForward;
}

const defaultMerchantDeps: MerchantDeps = { insertMerchantEventIfNew, checkAndForward };

/**
 * Records a merchant a macro reported and forwards it - once per arrival. No reward and no Network:
 * those are for biomes.
 */
export async function recordMerchantFind(
    message: Message,
    guildId: string,
    find: Omit<InsertMerchantEventParams, "discordMessageId">,
    deps: MerchantDeps = defaultMerchantDeps,
): Promise<void> {
    const eventId = await deps.insertMerchantEventIfNew({ ...find, discordMessageId: message.id }, settings.merchant.dedupWindowS);
    if (eventId === null) return;

    // The forward pipeline reads a find as a biome-shaped "started" event keyed by its target.
    await deps.checkAndForward(
        message,
        guildId,
        find.userId,
        {
            biome: merchantTarget(find.merchant),
            macroType: find.macroType ?? "unknown",
            eventType: "started",
            eventTimestamp: new Date(),
            serverLink: find.serverLink,
        },
        eventId,
    );
}
