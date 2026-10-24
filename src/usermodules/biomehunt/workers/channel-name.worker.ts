import { PermissionFlagsBits } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { defineWorker } from "@/define";
import { Logger } from "@/utils/logging";
import { type ChannelNameCandidate, getChannelNameCandidates, getChannelNameCounts, setNameBadges } from "../repository/users.repository";
import { type BiomeCounts, channelNameBadges, wantedChannelName } from "../services/channel-name.service";
import { clearLogDedup, guildLog } from "../services/guild-log.service";
import { settings } from "../settings";

const logger = new Logger("biomehunt.workers.channel-name");

/** What a tick needs from the database and Discord, injected so tests use neither. */
export interface ChannelNameDeps {
    now(): number;
    getCandidates(): Promise<ChannelNameCandidate[]>;
    getCounts(userIds: number[]): Promise<Map<number, BiomeCounts>>;
    setNameBadges(userId: number, badges: string): Promise<void>;
    /** The cached channel - null when the server or the channel isn't in the cache. */
    getChannel(guildId: string, channelId: string): { name: string; setName(name: string): Promise<unknown> } | null;
    canManageChannels(guildId: string): boolean;
    /** Manage Channels on this one channel (its own overwrites included). */
    canManageChannel(guildId: string, channelId: string): boolean;
    /** Tells the server's log channel the renames fail. */
    warn(guildId: string): Promise<void>;
    clearWarn(guildId: string): void;
}

const isMissingPermission = (err: unknown) => typeof err === "object" && err !== null && (err as { code?: unknown }).code === 50013;

/** Builds the tick. The servers the bot can't rename in are kept in memory, so a restart tries them once more. */
export function createChannelNameTick(deps: ChannelNameDeps): () => Promise<void> {
    const noPermission = new Set<string>();
    /** Channels whose own permissions refused a rename while the server's allowed it. */
    const channelDenied = new Map<string, string>();
    /** When each channel was last tried, so a failing one waits the gap too. */
    const attemptedAt = new Map<string, number>();
    const { minRenameGapMs, maxRenamesPerTick } = settings.channelName;

    return async () => {
        for (const guildId of [...noPermission]) {
            if (!deps.canManageChannels(guildId)) continue;
            noPermission.delete(guildId);
        }
        for (const [channelId, guildId] of [...channelDenied]) {
            if (deps.canManageChannel(guildId, channelId)) channelDenied.delete(channelId);
        }

        const candidates = await deps.getCandidates();
        const counts = await deps.getCounts(candidates.filter((c) => c.flagOn).map((c) => c.userId));
        const now = deps.now();
        let renamed = 0;

        for (const c of candidates) {
            if (renamed >= maxRenamesPerTick) break;
            if (noPermission.has(c.guildId) || channelDenied.has(c.channelId)) continue;
            if (c.renamedAt && now - c.renamedAt.getTime() < minRenameGapMs) continue;
            const attempted = attemptedAt.get(c.channelId);
            if (attempted !== undefined && now - attempted < minRenameGapMs) continue;

            const channel = deps.getChannel(c.guildId, c.channelId);
            if (!channel) continue;

            const badges = c.flagOn ? channelNameBadges(counts.get(c.userId) ?? []) : "";
            const wanted = wantedChannelName(channel.name, c.nameBadges, badges);
            if (wanted === channel.name) continue;

            renamed++;
            attemptedAt.set(c.channelId, now);
            try {
                await channel.setName(wanted);
                await deps.setNameBadges(c.userId, badges);
                deps.clearWarn(c.guildId);
            } catch (err) {
                if (isMissingPermission(err)) {
                    if (deps.canManageChannels(c.guildId)) channelDenied.set(c.channelId, c.guildId);
                    else noPermission.add(c.guildId);
                    await deps.warn(c.guildId);
                } else {
                    logger.error(err instanceof Error ? err : new Error(String(err)), { guild: c.guildId, channel: c.channelId });
                }
            }
        }
    };
}

function defaultDeps(client: BotClient): ChannelNameDeps {
    return {
        now: () => Date.now(),
        getCandidates: getChannelNameCandidates,
        getCounts: getChannelNameCounts,
        setNameBadges,
        getChannel: (guildId, channelId) => {
            const channel = client.guilds.cache.get(guildId)?.channels.cache.get(channelId);
            return channel ? { name: channel.name, setName: (name) => channel.setName(name) } : null;
        },
        canManageChannels: (guildId) =>
            client.guilds.cache.get(guildId)?.members.me?.permissions.has(PermissionFlagsBits.ManageChannels) ?? false,
        canManageChannel: (guildId, channelId) => {
            const guild = client.guilds.cache.get(guildId);
            const channel = guild?.channels.cache.get(channelId);
            return (guild?.members.me && channel?.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.ManageChannels)) ?? false;
        },
        warn: (guildId) =>
            guildLog(client, guildId, {
                kind: "warning",
                title: "⚠️ Couldn't rename macro channels",
                body: "The bot is missing **Manage Channels**, so the counts in channel names aren't updated.",
                dedupKey: "rename",
            }),
        clearWarn: (guildId) => clearLogDedup(guildId, "rename"),
    };
}

let tick: (() => Promise<void>) | null = null;

export const channelNameWorker = defineWorker({
    name: "channel-name",
    intervalMs: settings.workers.channelNameTickMs,
    run: async (client) => {
        tick ??= createChannelNameTick(defaultDeps(client));
        await tick();
    },
});
