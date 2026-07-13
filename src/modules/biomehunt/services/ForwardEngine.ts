import { MessageFlags } from "discord.js";
import type { Message } from "discord.js";
import { Logger } from "@/utils/logging";
import { getBiomeCountForUser } from "../repository/activity";
import { getForwardConfig } from "../repository/forwards";
import { BIOME_META, type ParsedEvent } from "../types";
import { buildForwardContainer } from "./forwardRender";
import { startVoteCheck } from "./VoteCheckEngine";

const logger = new Logger("biomehunt.ForwardEngine");

/**
 * Forwards a detected biome to its configured channel, every time it happens (no throttle -
 * this is a live "someone found X" alert, same trigger semantics as the badge system: only
 * a confirmed 'started' event fires it. Uses a Components V2 container instead of a regular
 * embed so we get a real Separator between the heading and the details. Rare-category biomes
 * additionally get admin confirm/deny buttons (see VoteCheckEngine).
 */
export async function checkAndForward(message: Message, guildId: string, userId: number, parsed: ParsedEvent): Promise<void> {
    if (parsed.eventType !== "started" || !parsed.biome) return;

    const forward = await getForwardConfig(guildId, parsed.biome);
    if (!forward) return;

    const channel = await message.client.channels.fetch(forward.channel_id).catch(() => null);
    if (!channel || channel.isDMBased() || !channel.isTextBased()) return;

    const jumpLink = `https://discord.com/channels/${guildId}/${message.channelId}/${message.id}`;
    const isRare = BIOME_META[parsed.biome]?.category === "rare";
    const findCount = await getBiomeCountForUser(userId, parsed.biome);

    const container = buildForwardContainer({
        biome: parsed.biome,
        roleId: forward.role_id,
        serverLink: parsed.serverLink,
        jumpLink,
        findCount,
        vote: isRare ? { status: "pending", decidedBy: null, decidedByUserId: null } : undefined,
    });

    try {
        const sent = await channel.send({ components: [container], flags: MessageFlags.IsComponentsV2 });
        if (isRare) startVoteCheck(sent, guildId, parsed.biome, forward.role_id, parsed.serverLink, jumpLink);
    } catch (err) {
        logger.error(err instanceof Error ? err : new Error(String(err)), { guildId, biome: parsed.biome });
    }
}
