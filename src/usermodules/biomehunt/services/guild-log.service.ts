import { ChannelType, ContainerBuilder, type MessageCreateOptions, MessageFlags } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { NO_PINGS } from "@/utils/format";
import { Logger } from "@/utils/logging";
import { newTraceRef } from "@/utils/trace";
import { getOrCreateGuildConfig } from "../repository/guilds.repository";
import { BiomeHuntError } from "../types";

const logger = new Logger("biomehunt.services.guild-log");

export type GuildLogKind = "warning" | "error" | "fake";

export interface GuildLogEntry {
    kind: GuildLogKind;
    title: string;
    body: string;
    /** Subtext line; defaults to ``ref `<traceRef>` ``. */
    footer?: string;
    /** Same guild + key posts once until `clearLogDedup`. */
    dedupKey?: string;
}

/** What the service needs from the database and Discord, injected so tests use neither. */
export interface GuildLogDeps {
    getLogChannelId(guildId: string): Promise<string | null>;
    send(channelId: string, payload: MessageCreateOptions): Promise<void>;
}

const ACCENTS: Record<GuildLogKind, number> = { warning: 0xf0b232, error: 0xda373c, fake: 0xda373c };

/** Dedup keys already posted this run: `guildId:dedupKey`. Lost on restart, which at worst repeats a warning once. */
const posted = new Set<string>();
const dedupId = (guildId: string, key: string) => `${guildId}:${key}`;

/** Lets `dedupKey` post again - call it when the thing that failed works again. */
export function clearLogDedup(guildId: string, dedupKey: string): void {
    posted.delete(dedupId(guildId, dedupKey));
}

export function defaultGuildLogDeps(client: BotClient): GuildLogDeps {
    return {
        getLogChannelId: async (guildId) => (await getOrCreateGuildConfig(guildId)).log_channel_id,
        send: async (channelId, payload) => {
            const channel = await client.channels.fetch(channelId);
            if (channel?.type !== ChannelType.GuildText && channel?.type !== ChannelType.GuildAnnouncement) {
                throw new Error(`Log channel ${channelId} isn't a text channel`);
            }
            await channel.send(payload);
        },
    };
}

function buildPayload(entry: GuildLogEntry): MessageCreateOptions {
    const footer = entry.footer ?? `ref \`${newTraceRef()}\``;
    const container = new ContainerBuilder()
        .setAccentColor(ACCENTS[entry.kind])
        .addTextDisplayComponents((td) => td.setContent(`**${entry.title}**\n${entry.body}`))
        .addTextDisplayComponents((td) => td.setContent(`-# ${footer}`));
    return { flags: MessageFlags.IsComponentsV2, components: [container], allowedMentions: NO_PINGS };
}

/**
 * Posts a problem to the server's log channel, if one is set. Never throws: a failed post is
 * logged to the console and dropped, so callers can fire it without a try/catch.
 */
export async function guildLog(
    client: BotClient,
    guildId: string,
    entry: GuildLogEntry,
    deps: GuildLogDeps = defaultGuildLogDeps(client),
): Promise<void> {
    try {
        const channelId = await deps.getLogChannelId(guildId);
        if (!channelId) return;
        const key = entry.dedupKey ? dedupId(guildId, entry.dedupKey) : null;
        if (key && posted.has(key)) return;
        await deps.send(channelId, buildPayload(entry));
        if (key) posted.add(key);
    } catch (err) {
        logger.warn(`Could not post to the log channel of ${guildId}`, { error: err instanceof Error ? err.message : String(err) });
    }
}

/**
 * One plain reason for a failed Discord call, for a log body. `override` replaces the wording of a
 * code for callers where it means something else (e.g. 50013 on a role is the role hierarchy).
 */
export function describeDiscordError(err: unknown, override: Partial<Record<number, string>> = {}): string {
    const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
    if (typeof code === "number") {
        const text =
            override[code] ??
            {
                50013: "the bot is missing **Send Messages** there",
                50001: "the bot can't see that channel",
                10003: "the channel no longer exists",
            }[code];
        if (text) return text;
    }
    return err instanceof Error ? err.message : String(err);
}

/** The settings screen's "Send a test": posts straight away and, unlike `guildLog`, tells the admin when it can't. */
export async function sendLogTest(client: BotClient, guildId: string, deps: GuildLogDeps = defaultGuildLogDeps(client)): Promise<string> {
    const channelId = await deps.getLogChannelId(guildId);
    if (!channelId) throw new BiomeHuntError("Pick a channel first.");
    try {
        await deps.send(channelId, buildPayload({ kind: "warning", title: "🧪 Test", body: "Log posts will show up here." }));
    } catch {
        throw new BiomeHuntError(`I can't post in <#${channelId}>. Check my permissions there.`);
    }
    return `Test posted in <#${channelId}>.`;
}
