import { DiscordAPIError, PermissionFlagsBits, RESTJSONErrorCodes } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { NO_PINGS } from "@/utils/format";
import { Logger } from "@/utils/logging";
import { updateSticky } from "../repository/stickies.repository";
import type { StickyMode, StickyRow } from "../types";
import { stickyCache } from "./sticky-cache";

export interface MessageAuthor {
    authorId: string;
    authorIsBot: boolean;
    webhookId: string | null;
}

/** The bot's own messages never count; `nobots` also ignores every other bot and webhook. */
export function countsForRepost(msg: MessageAuthor, mode: StickyMode, botUserId: string): boolean {
    if (msg.authorId === botUserId) return false;
    if (mode === "nobots" && (msg.authorIsBot || msg.webhookId !== null)) return false;
    return true;
}

/** True when the sticky is not posted yet or its delay since the last post has passed. */
export function delayPassed(sticky: StickyRow, now: Date): boolean {
    if (sticky.message_id === null || sticky.last_posted_at === null) return true;
    return now.getTime() - sticky.last_posted_at.getTime() >= sticky.delay_seconds * 1000;
}

export interface RepostDeps {
    now(): Date;
    /** True when the bot can post and delete in the channel. */
    canManage(channelId: string): Promise<boolean>;
    /** Returns the new message id. */
    send(channelId: string, content: string): Promise<string>;
    /** Ignores Unknown Message. */
    remove(channelId: string, messageId: string): Promise<void>;
    save(channelId: string, messageId: string, at: Date): Promise<void>;
    /** Persists `message_id = null` after the posted message was deleted by someone else. */
    clearMessage(channelId: string): Promise<void>;
    log(err: Error): void;
}

export type PostResult = { posted: true } | { posted: false; reason: string };

export interface Reposter {
    onMessage(channelId: string, msg: MessageAuthor, botUserId: string): Promise<void>;
    postNow(sticky: StickyRow): Promise<PostResult>;
    onMessageDeleted(channelId: string, messageId: string): void;
}

const logger = new Logger("sticky");

const asError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

export function createReposter(deps: RepostDeps): Reposter {
    const locks = new Map<string, Promise<void>>();
    /** Time of the last failed attempt per channel (memory only); the next automatic try waits one delay. */
    const failedAt = new Map<string, Date>();

    async function repost(sticky: StickyRow): Promise<PostResult> {
        const channelId = sticky.channel_id;
        let messageId: string;
        try {
            if (!(await deps.canManage(channelId))) throw new Error(`Missing permissions to post or delete in channel ${channelId}`);
            messageId = await deps.send(channelId, sticky.content);
        } catch (err) {
            failedAt.set(channelId, deps.now());
            deps.log(asError(err));
            return { posted: false, reason: "I need Send Messages and Manage Messages there." };
        }
        failedAt.delete(channelId);
        const at = deps.now();
        const latest = stickyCache.get(channelId);
        if (latest) stickyCache.set({ ...latest, message_id: messageId, last_posted_at: at });
        else await deps.remove(channelId, messageId).catch((err) => deps.log(asError(err)));
        try {
            await deps.save(channelId, messageId, at);
        } catch (err) {
            deps.log(asError(err));
        }
        if (sticky.message_id !== null) await deps.remove(channelId, sticky.message_id).catch((err) => deps.log(asError(err)));
        return { posted: true };
    }

    /** Chains `repost` after any run in flight on the channel, so two runs never overlap. */
    function locked(sticky: StickyRow): Promise<PostResult> {
        const id = sticky.channel_id;
        const run = (locks.get(id) ?? Promise.resolve()).then(() => repost(stickyCache.get(id) ?? sticky));
        const tail: Promise<void> = run
            .then(
                () => {},
                () => {},
            )
            .finally(() => {
                if (locks.get(id) === tail) locks.delete(id);
            });
        locks.set(id, tail);
        return run;
    }

    return {
        async onMessage(channelId, msg, botUserId) {
            const sticky = stickyCache.get(channelId);
            if (!sticky || locks.has(channelId)) return;
            if (!countsForRepost(msg, sticky.mode, botUserId)) return;
            const now = deps.now();
            if (!delayPassed(sticky, now)) return;
            const failed = failedAt.get(channelId);
            if (failed && now.getTime() - failed.getTime() < sticky.delay_seconds * 1000) return;
            await locked(sticky);
        },
        postNow: (sticky) => locked(sticky),
        onMessageDeleted(channelId, messageId) {
            const sticky = stickyCache.get(channelId);
            if (!sticky || sticky.message_id !== messageId) return;
            stickyCache.set({ ...sticky, message_id: null });
            deps.clearMessage(channelId).catch((err) => deps.log(asError(err)));
        },
    };
}

export function defaultRepostDeps(client: BotClient): RepostDeps {
    async function textChannel(channelId: string) {
        const channel = await client.channels.fetch(channelId);
        if (!channel?.isTextBased() || !("send" in channel)) throw new Error(`Channel ${channelId} is not a sendable text channel`);
        return channel;
    }
    return {
        now: () => new Date(),
        async canManage(channelId) {
            const channel = await textChannel(channelId);
            if (!("guild" in channel) || !("permissionsFor" in channel)) return false;
            const me = channel.guild.members.me ?? (await channel.guild.members.fetchMe());
            return channel.permissionsFor(me)?.has([PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages]) ?? false;
        },
        async send(channelId, content) {
            const channel = await textChannel(channelId);
            const sent = await channel.send({ content, allowedMentions: NO_PINGS });
            return sent.id;
        },
        async remove(channelId, messageId) {
            const channel = await textChannel(channelId);
            try {
                await channel.messages.delete(messageId);
            } catch (err) {
                if (err instanceof DiscordAPIError && err.code === RESTJSONErrorCodes.UnknownMessage) return;
                throw err;
            }
        },
        async save(channelId, messageId, at) {
            await updateSticky(channelId, { message_id: messageId, last_posted_at: at });
        },
        async clearMessage(channelId) {
            await updateSticky(channelId, { message_id: null });
        },
        log: (err) => logger.error(err),
    };
}
