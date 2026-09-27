import type { Client, Message } from "discord.js";
import { ContainerBuilder, MessageFlags } from "discord.js";
import { Logger } from "@/utils/logging";
import { BIOME_META, formatBiomeName, resolveBiomeSelector } from "../constants/biomes.constants";
import { getBiomeCountForUser } from "../repository/activity.repository";
import { getForwardConfig, getForwardConfigs, removeForwardConfig, setForwardConfig } from "../repository/forwards.repository";
import { newVoteId, openVote } from "../services/biome-vote.service";
import { settings } from "../settings";
import { BiomeHuntError, type ParsedEvent, VoteStatus } from "../types";
import { buildForwardContainer } from "../views/forward-post.view";

const logger = new Logger("biomehunt.services.forward");

/**
 * Everything `forwardBiome` would otherwise call directly on the repository/vote service, injected
 * so its tests (and `checkAndForward`'s) never touch a DB - `defaultForwardServiceDeps` wires the
 * real functions.
 */
export interface ForwardServiceDeps {
    getForwardConfig: typeof getForwardConfig;
    getBiomeCountForUser: typeof getBiomeCountForUser;
    newVoteId: typeof newVoteId;
    openVote: typeof openVote;
}

export function defaultForwardServiceDeps(): ForwardServiceDeps {
    return { getForwardConfig, getBiomeCountForUser, newVoteId, openVote };
}

/**
 * Forwards a detected biome to its configured channel, every time it happens (no throttle -
 * this is a live "someone found X" alert, same trigger semantics as the badge system: only
 * a confirmed 'started' event fires it. Builds the jump link from the source message, then
 * delegates everything else to `forwardBiome`.
 */
export async function checkAndForward(
    message: Message,
    guildId: string,
    userId: number,
    parsed: ParsedEvent,
    eventId: number,
    deps: ForwardServiceDeps = defaultForwardServiceDeps(),
): Promise<void> {
    const jumpLink = `https://discord.com/channels/${guildId}/${message.channelId}/${message.id}`;
    await forwardBiome(message.client, guildId, userId, parsed, eventId, jumpLink, deps);
}

/**
 * The core of `checkAndForward`, factored out so `/bh-owner simulate-biome` can drive the exact
 * same forward+vote pipeline for a synthetic event - it has no source message to derive a jump
 * link from, so it supplies its own (a link to the invoking message, or the channel). Uses a
 * Components V2 container instead of a regular embed so we get a real Separator between the
 * heading and the details. Rare-category biomes additionally open a 1-minute community vote (see
 * services/biome-vote.service.ts) - the vote id is generated here, BEFORE the message is sent, so
 * the message can show it right away.
 */
export async function forwardBiome(
    client: Client,
    guildId: string,
    userId: number,
    parsed: ParsedEvent,
    /** `null` for a dry-run simulation - the vote then has nothing to reward or delete. */
    eventId: number | null,
    jumpLink: string,
    deps: ForwardServiceDeps = defaultForwardServiceDeps(),
): Promise<void> {
    if (parsed.eventType !== "started" || !parsed.biome) return;

    const forward = await deps.getForwardConfig(guildId, parsed.biome);
    if (!forward) return;

    const channel = await client.channels.fetch(forward.channel_id).catch(() => null);
    if (!channel || channel.isDMBased() || !channel.isTextBased()) return;

    const isRare = BIOME_META[parsed.biome]?.category === "rare";
    const findCount = await deps.getBiomeCountForUser(userId, parsed.biome);
    const voteId = isRare ? deps.newVoteId() : null;
    const now = new Date();
    const closesAt = new Date(now.getTime() + settings.votes.windowMs);

    const container = buildForwardContainer({
        biome: parsed.biome,
        roleId: forward.role_id,
        serverLink: parsed.serverLink,
        jumpLink,
        findCount,
        vote: voteId ? { voteId, status: VoteStatus.OPEN, closesAt, voteCount: 0 } : undefined,
    });

    try {
        const sent = await channel.send({ components: [container], flags: MessageFlags.IsComponentsV2 });
        if (voteId) {
            await deps.openVote({
                voteId, guildId, eventId, finderUserId: userId, channelId: sent.channelId, messageId: sent.id, biome: parsed.biome,
                roleId: forward.role_id, serverLink: parsed.serverLink, jumpLink, findCount, now,
            });
        }
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
