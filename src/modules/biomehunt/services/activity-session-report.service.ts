import { MessageFlags } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { Logger } from "@/utils/logging";
import { getBiomeCountsInRange, getLatestSessionForUser } from "../repository/activity.repository";
import { getMacroChannelByUserId } from "../repository/users.repository";
import { buildSessionEndContainer } from "../views/session-end.view";

const logger = new Logger("biomehunt.services.activity-session-report");

/** Posts a summary of a user's just-finished session (duration + biome breakdown) to their macro channel. */
export async function reportSessionEnd(client: BotClient, userId: number): Promise<void> {
    const session = await getLatestSessionForUser(userId);
    if (!session) return;

    const macroChannel = await getMacroChannelByUserId(userId);
    if (!macroChannel) return;

    const channel = await client.channels.fetch(macroChannel.channel_id).catch(() => null);
    if (!channel || channel.isDMBased() || !channel.isTextBased()) return;

    const biomes = await getBiomeCountsInRange(userId, session.started_at, session.ended_at);
    const container = buildSessionEndContainer(session, biomes);

    try {
        await channel.send({ flags: MessageFlags.IsComponentsV2, components: [container] });
    } catch (err) {
        logger.error(err instanceof Error ? err : new Error(String(err)), { userId });
    }
}
