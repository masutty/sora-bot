import { type Client, DiscordAPIError, type MessageCreateOptions, MessageFlags } from "discord.js";
import { UserFacingError } from "@/define";
import { Logger } from "@/utils/logging";
import * as repo from "../repository/panels.repository";
import type { OptionRow, PanelRow } from "../types";
import { buildRootPage } from "../views/panel.render";

const logger = new Logger("infopanel.service");

/** Discord error codes for "the message/channel is gone" and "the bot can no longer reach it". */
const UNREACHABLE = new Set([10003, 10008, 50001, 50013]);

/** Discord refused the payload itself (Invalid Form Body) - e.g. an emoji or image it will not take. */
const INVALID_BODY = 50035;
const REJECTED = "Discord rejected the panel. Check its emojis and images.";

const isInvalidBody = (err: unknown) => err instanceof DiscordAPIError && Number(err.code) === INVALID_BODY;

/** How the service posts, edits and removes the panel's message. Injected so the view and service tests never touch Discord. */
export interface Publisher {
    send(channelId: string, payload: MessageCreateOptions): Promise<string>;
    /** "gone" when the message or channel no longer exists or the bot lost access. */
    edit(channelId: string, messageId: string, payload: MessageCreateOptions): Promise<"ok" | "gone">;
    remove(channelId: string, messageId: string): Promise<void>;
}

export function discordPublisher(client: Client): Publisher {
    const channelOf = async (channelId: string) => {
        const channel = await client.channels.fetch(channelId);
        if (!channel?.isSendable()) throw new UserFacingError("I can't post in that channel.");
        return channel;
    };
    return {
        async send(channelId, payload) {
            try {
                const message = await (await channelOf(channelId)).send(payload);
                return message.id;
            } catch (err) {
                if (err instanceof DiscordAPIError && UNREACHABLE.has(Number(err.code)))
                    throw new UserFacingError("I can't post in that channel.");
                if (isInvalidBody(err)) throw new UserFacingError(REJECTED);
                throw err;
            }
        },
        async edit(channelId, messageId, payload) {
            try {
                const channel = await channelOf(channelId);
                await channel.messages.edit(messageId, payload as never);
                return "ok";
            } catch (err) {
                if (err instanceof UserFacingError) return "gone";
                if (err instanceof DiscordAPIError && UNREACHABLE.has(Number(err.code))) return "gone";
                if (isInvalidBody(err)) throw new UserFacingError(REJECTED);
                throw err;
            }
        },
        async remove(channelId, messageId) {
            try {
                const channel = await channelOf(channelId);
                await channel.messages.delete(messageId);
            } catch (err) {
                if (err instanceof UserFacingError) return;
                if (err instanceof DiscordAPIError && UNREACHABLE.has(Number(err.code))) return;
                throw err;
            }
        },
    };
}

/** The message body of the posted root. */
export function rootMessage(panel: PanelRow, options: OptionRow[]): MessageCreateOptions {
    return { ...buildRootPage(panel, options), flags: MessageFlags.IsComponentsV2 } as MessageCreateOptions;
}

export interface PanelService {
    /** Brings the posted message up to date. Forgets it (Not posted) when it is gone. A no-op when the panel was never posted. */
    refresh(panelId: number): Promise<void>;
    /** Posts the panel in `channelId`, or moves it there; edits in place when it stays in the same channel. */
    publish(panelId: number, channelId: string): Promise<void>;
    /** Deletes the panel and its posted message. */
    remove(panelId: number): Promise<void>;
}

/** The repository calls the service makes, injected so its tests never hit the database. */
export type PanelStore = Pick<typeof repo, "getPanel" | "listOptions" | "updatePanel" | "deletePanel">;

export function panelService(publisher: Publisher, store: PanelStore = repo): PanelService {
    const forget = (panelId: number) => store.updatePanel(panelId, { channel_id: null, message_id: null });

    return {
        async refresh(panelId) {
            const panel = await store.getPanel(panelId);
            if (!panel?.channel_id || !panel.message_id) return;
            const result = await publisher.edit(panel.channel_id, panel.message_id, rootMessage(panel, await store.listOptions(panel.id)));
            if (result === "gone") await forget(panel.id);
        },

        async publish(panelId, channelId) {
            const panel = await store.getPanel(panelId);
            if (!panel) throw new UserFacingError("This panel no longer exists.");
            const options = await store.listOptions(panel.id);
            if (options.length === 0) throw new UserFacingError("Add at least one option before posting the panel.");
            const body = rootMessage(panel, options);
            if (panel.channel_id === channelId && panel.message_id) {
                if ((await publisher.edit(channelId, panel.message_id, body)) === "ok") return;
            }
            const messageId = await publisher.send(channelId, body);
            if (panel.channel_id && panel.message_id && panel.channel_id !== channelId) {
                await publisher
                    .remove(panel.channel_id, panel.message_id)
                    .catch((err) => logger.warn(`Could not remove the old panel message: ${err}`));
            }
            await store.updatePanel(panel.id, { channel_id: channelId, message_id: messageId });
        },

        async remove(panelId) {
            const panel = await store.getPanel(panelId);
            if (!panel) return;
            if (panel.channel_id && panel.message_id) {
                await publisher
                    .remove(panel.channel_id, panel.message_id)
                    .catch((err) => logger.warn(`Could not remove the panel message: ${err}`));
            }
            await store.deletePanel(panel.id);
        },
    };
}
