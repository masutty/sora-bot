import { ContainerBuilder, MessageFlags } from "discord.js";
import type { Message } from "discord.js";
import { Logger } from "@/utils/logging";
import { getBiomeCountForUser } from "../repository/activity.repository";
import { getForwardConfig, getForwardConfigs, removeForwardConfig, setForwardConfig } from "../repository/forwards.repository";
import { BIOME_META, formatBiomeName, resolveBiomeSelector } from "../constants/biomes.constants";
import { BiomeHuntError, type ParsedEvent } from "../types";
import { buildForwardContainer } from "./forwardRender";
import { startVoteCheck } from "./vote-check.service";

const logger = new Logger("biomehunt.ForwardEngine");

/**
 * Forwards a detected biome to its configured channel, every time it happens (no throttle -
 * this is a live "someone found X" alert, same trigger semantics as the badge system: only
 * a confirmed 'started' event fires it. Uses a Components V2 container instead of a regular
 * embed so we get a real Separator between the heading and the details. Rare-category biomes
 * additionally get admin confirm/deny buttons (see VoteCheckEngine).
 */
export async function checkAndForward(message: Message, guildId: string, userId: number, parsed: ParsedEvent, eventId: number): Promise<void> {
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
        if (isRare) startVoteCheck(sent, guildId, userId, eventId, parsed.biome, forward.role_id, parsed.serverLink, jumpLink);
    } catch (err) {
        logger.error(err instanceof Error ? err : new Error(String(err)), { guildId, biome: parsed.biome });
    }
}

async function applyForward(guildId: string, selector: string, channelId: string, roleId: string | null): Promise<string> {
    const biomes = resolveBiomeSelector(selector);
    for (const biome of biomes) await setForwardConfig(guildId, biome, channelId, roleId);

    const roleNote = roleId ? `, pinging <@&${roleId}>` : "";
    if (biomes.length === 1) return `${formatBiomeName(biomes[0])} will now be forwarded to <#${channelId}>${roleNote}.`;
    return `${biomes.length} biomes will now be forwarded to <#${channelId}>${roleNote}: ${biomes.map(formatBiomeName).join(", ")}.`;
}

/**
 * `channel` is optional: omitting it (with no `role` either) removes the forward instead of
 * setting it. Passing `role` without `channel` is rejected - a role ping needs a destination.
 */
export async function setForward(guildId: string, selector: string, channelId: string | null, roleId: string | null): Promise<string> {
    if (!channelId) {
        if (roleId) throw new BiomeHuntError("Missing required argument: channel");
        return removeForward(guildId, selector);
    }
    return applyForward(guildId, selector, channelId, roleId);
}

async function removeForward(guildId: string, selector: string): Promise<string> {
    const biomes = resolveBiomeSelector(selector);
    const removed: string[] = [];
    for (const biome of biomes) {
        if (await removeForwardConfig(guildId, biome)) removed.push(biome);
    }

    if (removed.length === 0) throw new BiomeHuntError("No matching biome forward is configured.");
    if (removed.length === 1) return `Forward for ${formatBiomeName(removed[0])} removed.`;
    return `Removed ${removed.length} biome forward(s): ${removed.map(formatBiomeName).join(", ")}.`;
}

export async function listForwards(guildId: string): Promise<ContainerBuilder> {
    const forwards = await getForwardConfigs(guildId);
    const container = new ContainerBuilder().setAccentColor(0x5865f2);

    if (forwards.length === 0) {
        container.addTextDisplayComponents((td) => td.setContent("**Biome Forwards**\nNo biome forwards configured yet."));
        return container;
    }

    const lines = forwards.map((f) => `${formatBiomeName(f.biome)} - <#${f.channel_id}>${f.role_id ? ` (pings <@&${f.role_id}>)` : ""}`);
    container.addTextDisplayComponents((td) => td.setContent(`**Biome Forwards**\n${lines.join("\n")}`));
    return container;
}
