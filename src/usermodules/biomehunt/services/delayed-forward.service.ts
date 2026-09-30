import type { Client } from "discord.js";
import { ContainerBuilder, MessageFlags } from "discord.js";
import { Logger } from "@/utils/logging";
import { formatBiomeName, resolveBiomeSelector } from "../constants/biomes.constants";
import { eventExists } from "../repository/activity.repository";
import { getDelayedForwardConfigs, removeDelayedForwardConfig, setDelayedForwardConfig } from "../repository/delayed-forwards.repository";
import { getVoteById } from "../repository/votes.repository";
import { settings } from "../settings";
import { type BiomeDelayedForwardRow, BiomeHuntError, VoteStatus } from "../types";
import { formatForwardLine } from "../views/forward-list.view";
import { buildForwardContainer, type ForwardFindStats, forwardMentions } from "../views/forward-post.view";

const logger = new Logger("biomehunt.services.delayed-forward");

/** Injected so tests never touch the DB or wait on a real timer - `defaultDelayedForwardDeps` wires the real ones. */
export interface DelayedForwardDeps {
    eventExists: typeof eventExists;
    getVoteById: typeof getVoteById;
    schedule(fn: () => Promise<void>, ms: number): void;
}

export function defaultDelayedForwardDeps(): DelayedForwardDeps {
    return {
        eventExists,
        getVoteById,
        schedule: (fn, ms) => {
            setTimeout(() => void fn(), ms);
        },
    };
}

/** Everything the delayed message needs, captured at find time - nothing is re-derived when the timer fires. */
export interface DelayedForwardJob {
    client: Client;
    guildId: string;
    config: BiomeDelayedForwardRow;
    biome: string;
    serverLink: string | null;
    jumpLink: string;
    stats: ForwardFindStats;
    /** `null` for a dry-run simulation - there's no event that could get deleted. */
    eventId: number | null;
    /** The live forward's vote, if it opened one - a fake/denied outcome cancels the delayed send. */
    voteId: string | null;
    /** A `/bh-owner simulate-biome` dry run - sent without pinging anyone. */
    dryRun: boolean;
}

/**
 * Sends the delayed forward `config.delay_s` seconds from now. The pending send only lives in
 * memory (a restart drops it) - accepted, since delays are capped at 60s.
 */
export function scheduleDelayedForward(job: DelayedForwardJob, deps: DelayedForwardDeps = defaultDelayedForwardDeps()): void {
    deps.schedule(() => sendDelayedForward(job, deps), job.config.delay_s * 1000);
}

/** A find invalidated during the delay (its event deleted, or its vote ruled fake) never gets the delayed ping. */
async function isInvalidated(job: DelayedForwardJob, deps: DelayedForwardDeps): Promise<boolean> {
    if (job.eventId !== null && !(await deps.eventExists(job.eventId))) return true;
    if (!job.voteId) return false;
    const vote = await deps.getVoteById(job.voteId);
    return vote?.status === VoteStatus.COMMUNITY_FAKE || vote?.status === VoteStatus.ADMIN_DENIED;
}

export async function sendDelayedForward(job: DelayedForwardJob, deps: DelayedForwardDeps = defaultDelayedForwardDeps()): Promise<void> {
    try {
        if (await isInvalidated(job, deps)) {
            logger.info(`Delayed forward of ${job.biome} cancelled - find was invalidated during the delay`, { guildId: job.guildId });
            return;
        }

        const channel = await job.client.channels.fetch(job.config.channel_id).catch(() => null);
        if (!channel || channel.isDMBased() || !channel.isTextBased()) return;

        const container = buildForwardContainer({
            biome: job.biome,
            roleId: job.config.role_id,
            serverLink: job.serverLink,
            jumpLink: job.jumpLink,
            ...job.stats,
            badges: { delayed: true, simulated: job.dryRun },
        });
        await channel.send({
            components: [container],
            flags: MessageFlags.IsComponentsV2,
            allowedMentions: forwardMentions(job.config.role_id, job.dryRun),
        });
    } catch (err) {
        logger.error(err instanceof Error ? err : new Error(String(err)), { guildId: job.guildId, biome: job.biome });
    }
}

/** Prefix invocations don't enforce the slash option's choices, so the delay is re-checked here. */
function requireValidDelay(delayS: number | null): number {
    const choices: readonly number[] = settings.delayedForward.delayChoicesS;
    if (delayS === null) throw new BiomeHuntError("Missing required argument: delay");
    if (!choices.includes(delayS)) throw new BiomeHuntError(`Delay must be one of: ${choices.join(", ")} seconds.`);
    return delayS;
}

/**
 * Same contract as `setForward`: omitting `channel` (with no `role`/`delay` either) removes the
 * delayed forward instead. Setting one requires a delay.
 */
export async function setDelayedForward(
    guildId: string,
    selector: string,
    channelId: string | null,
    roleId: string | null,
    delayS: number | null,
): Promise<string> {
    if (!channelId) {
        if (roleId || delayS !== null) throw new BiomeHuntError("Missing required argument: channel");
        return removeDelayedForward(guildId, selector);
    }

    const delay = requireValidDelay(delayS);
    const biomes = resolveBiomeSelector(selector);
    for (const biome of biomes) await setDelayedForwardConfig(guildId, biome, channelId, roleId, delay);

    const roleNote = roleId ? `, pinging <@&${roleId}>` : "";
    const target = `<#${channelId}> after ${delay}s${roleNote}`;
    if (biomes.length === 1) return `${formatBiomeName(biomes[0])} will now be delay-forwarded to ${target}.`;
    return `${biomes.length} biomes will now be delay-forwarded to ${target}: ${biomes.map(formatBiomeName).join(", ")}.`;
}

async function removeDelayedForward(guildId: string, selector: string): Promise<string> {
    const biomes = resolveBiomeSelector(selector);
    const removed: string[] = [];
    for (const biome of biomes) {
        if (await removeDelayedForwardConfig(guildId, biome)) removed.push(biome);
    }

    if (removed.length === 0) throw new BiomeHuntError("No matching delayed biome forward is configured.");
    if (removed.length === 1) return `Delayed forward for ${formatBiomeName(removed[0])} removed.`;
    return `Removed ${removed.length} delayed biome forward(s): ${removed.map(formatBiomeName).join(", ")}.`;
}

export async function listDelayedForwards(guildId: string): Promise<ContainerBuilder> {
    const forwards = await getDelayedForwardConfigs(guildId);
    const container = new ContainerBuilder().setAccentColor(0x5865f2);
    const body = forwards.length === 0 ? "No delayed biome forwards configured yet." : forwards.map(formatForwardLine).join("\n");
    container.addTextDisplayComponents((td) => td.setContent(`**Delayed Biome Forwards**\n${body}`));
    return container;
}
