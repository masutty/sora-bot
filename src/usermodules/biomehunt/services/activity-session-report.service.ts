import { MessageFlags } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { Logger } from "@/utils/logging";
import {
    getActiveSecondsBetween,
    getActiveSecondsInWindow,
    getBiomeCountsInRange,
    getLatestSessionForUser,
} from "../repository/activity.repository";
import { getOrCreateGuildConfig } from "../repository/guilds.repository";
import { getMacroChannelByUserId, getUserById } from "../repository/users.repository";
import { buildSessionEndContainer } from "../views/session-end.view";
import { RECENT_ACTIVITY_WINDOW_HOURS } from "../views/stats-builders";
import { quotaDayWindow } from "./quota-report.service";

const logger = new Logger("biomehunt.services.activity-session-report");

/** Posts a summary of a user's just-finished session (duration + biome breakdown) to their macro channel. */
export async function reportSessionEnd(client: BotClient, userId: number): Promise<void> {
    const session = await getLatestSessionForUser(userId);
    if (!session) return;

    const macroChannel = await getMacroChannelByUserId(userId);
    if (!macroChannel) return;

    const channel = await client.channels.fetch(macroChannel.channel_id).catch(() => null);
    if (!channel || channel.isDMBased() || !channel.isTextBased()) return;

    const user = await getUserById(userId);
    if (!user) return;

    const guildConfig = await getOrCreateGuildConfig(user.guild_id);
    const quotaDay = quotaDayWindow(guildConfig.quota_eval_hour_utc, new Date());

    const [biomes, windowSeconds, todaySeconds] = await Promise.all([
        getBiomeCountsInRange(userId, session.started_at, session.ended_at),
        getActiveSecondsInWindow(userId, RECENT_ACTIVITY_WINDOW_HOURS),
        getActiveSecondsBetween(userId, quotaDay.start, quotaDay.end),
    ]);
    const container = buildSessionEndContainer(session, biomes, {
        todaySeconds,
        windowSeconds,
        windowHours: RECENT_ACTIVITY_WINDOW_HOURS,
    });

    try {
        await channel.send({ flags: MessageFlags.IsComponentsV2, components: [container] });
    } catch (err) {
        logger.error(err instanceof Error ? err : new Error(String(err)), { userId });
    }
}
