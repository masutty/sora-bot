import type { BotClient } from "@/core/bot-client";
import { Logger } from "@/utils/logging";
import type { MessageAuthor, Reposter } from "./services/repost.service";
import { stickyCache } from "./services/sticky-cache";

const logger = new Logger("sticky");

const asError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

export interface StickyEventDeps {
    reposter(client: BotClient): Reposter;
    deleteRow(channelId: string): Promise<unknown>;
}

interface MessageLike {
    guild: unknown;
    channelId: string;
    author: { id: string; bot: boolean };
    webhookId: string | null;
}

/** Gateway handlers of the sticky cog, with the reposter and the database injected. */
export function createStickyEvents(deps: StickyEventDeps) {
    return {
        async messageCreate(client: BotClient, message: MessageLike): Promise<void> {
            if (!message.guild) return;
            if (!stickyCache.get(message.channelId) || !client.user) return;
            const author: MessageAuthor = { authorId: message.author.id, authorIsBot: message.author.bot, webhookId: message.webhookId };
            try {
                await deps.reposter(client).onMessage(message.channelId, author, client.user.id);
            } catch (err) {
                logger.error(asError(err));
            }
        },

        async messageDelete(client: BotClient, message: { guildId: string | null; channelId: string; id: string }): Promise<void> {
            if (!message.guildId) return;
            if (!stickyCache.get(message.channelId)) return;
            deps.reposter(client).onMessageDeleted(message.channelId, message.id);
        },

        async messageDeleteBulk(
            client: BotClient,
            messages: { keys(): Iterable<string> },
            channel: { id: string; guildId?: string | null },
        ): Promise<void> {
            if (!channel.guildId || !stickyCache.get(channel.id)) return;
            const reposter = deps.reposter(client);
            for (const id of messages.keys()) reposter.onMessageDeleted(channel.id, id);
        },

        async channelDelete(_client: BotClient, channel: { id: string }): Promise<void> {
            if (!stickyCache.get(channel.id)) return;
            stickyCache.delete(channel.id);
            await deps.deleteRow(channel.id).catch((err) => logger.error(asError(err)));
        },
    };
}
