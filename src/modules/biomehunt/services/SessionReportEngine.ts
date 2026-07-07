import { EmbedBuilder } from "discord.js";
import type { BotClient } from "@/core/BotClient";
import { formatTime } from "@/utils/format";
import { Logger } from "@/utils/logging";
import { getBiomeCountsInRange, getLatestSessionForUser } from "../repository/activity";
import { getMacroChannelByUserId } from "../repository/users";
import { formatBiomeName } from "../types";

const logger = new Logger("biomehunt.SessionReportEngine");

/** Posts a summary of a user's just-finished session (duration + biome breakdown) to their macro channel. */
export async function reportSessionEnd(client: BotClient, userId: number): Promise<void> {
    const session = await getLatestSessionForUser(userId);
    if (!session) return;

    const macroChannel = await getMacroChannelByUserId(userId);
    if (!macroChannel) return;

    const channel = await client.channels.fetch(macroChannel.channel_id).catch(() => null);
    if (!channel || channel.isDMBased() || !channel.isTextBased()) return;

    const biomes = await getBiomeCountsInRange(userId, session.started_at, session.ended_at);
    const biomeLines = biomes.length > 0
        ? biomes.map((b) => `${formatBiomeName(b.biome)}: ${b.count}`).join("\n")
        : "No biomes recorded.";

    const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("Session Ended")
        .setDescription(`Duration: \`${formatTime(session.duration_seconds)}\``)
        .addFields({ name: "Biomes", value: biomeLines });

    try {
        await channel.send({ embeds: [embed] });
    } catch (err) {
        logger.error(err instanceof Error ? err : new Error(String(err)), { userId });
    }
}
