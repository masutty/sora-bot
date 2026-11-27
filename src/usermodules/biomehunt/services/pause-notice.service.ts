import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type MessageCreateOptions, MessageFlags } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { Logger } from "@/utils/logging";
import { markNoticeSent, type PauseRow } from "../repository/pauses.repository";
import { getMacroChannelByUserId, getUserById } from "../repository/users.repository";
import { buildPauseNotice } from "../views/pause-notice.view";
import { describeDiscordError, guildLog } from "./guild-log.service";
import type { MemberPause } from "./pause.service";

const logger = new Logger("biomehunt.services.pause-notice");

/** Database and Discord access, injected so tests use neither. */
export interface PauseNoticeDeps {
    getUserById: typeof getUserById;
    getMacroChannel: typeof getMacroChannelByUserId;
    /** Resolves the sent message's id. */
    send(channelId: string, payload: MessageCreateOptions): Promise<{ id: string } | undefined>;
    markNoticeSent: typeof markNoticeSent;
    guildLog: typeof guildLog;
}

export function defaultPauseNoticeDeps(client: BotClient): PauseNoticeDeps {
    return {
        getUserById,
        getMacroChannel: getMacroChannelByUserId,
        send: async (channelId, payload) => {
            const channel = await client.channels.fetch(channelId);
            if (!channel?.isSendable()) throw Object.assign(new Error(`Channel ${channelId} is not sendable`), { code: 10003 });
            return channel.send(payload);
        },
        markNoticeSent,
        guildLog,
    };
}

/** Posts the Notice in the member's Macro Channel. Never throws: returns whether it went out. A pause with no message (legacy) has no Notice. */
export async function sendPauseNotice(
    client: BotClient,
    userId: number,
    pause: PauseRow,
    deps: PauseNoticeDeps = defaultPauseNoticeDeps(client),
): Promise<boolean> {
    if (pause.message === null) return false;
    let who: { guildId: string; discordId: string } | null = null;
    try {
        const user = await deps.getUserById(userId);
        if (!user) return false;
        who = { guildId: user.guild_id, discordId: user.discord_user_id };
        const channel = await deps.getMacroChannel(userId);
        if (!channel) throw Object.assign(new Error("No Macro Channel"), { code: 10003 });
        const sent = await deps.send(channel.channel_id, {
            flags: MessageFlags.IsComponentsV2,
            components: buildPauseNotice(pause, user.discord_user_id),
            allowedMentions: { users: [user.discord_user_id] },
        });
        await deps.markNoticeSent(pause.id, sent ? { channelId: channel.channel_id, messageId: sent.id } : undefined);
        return true;
    } catch (err) {
        logger.warn(`Could not send the Notice of pause ${pause.id}`, { error: err instanceof Error ? err.message : String(err) });
        if (who) {
            await deps.guildLog(client, who.guildId, {
                kind: "warning",
                title: "Pause Notice not sent",
                body: `The Notice for <@${who.discordId}> did not go out: ${describeDiscordError(err)}.`,
                dedupKey: `pause-notice:${userId}`,
            });
        }
        return false;
    }
}

/** One reminder, under no container, linking to the unanswered Notice. Never throws. */
export async function sendPauseReminder(
    client: BotClient,
    userId: number,
    pause: PauseRow,
    deps: PauseNoticeDeps = defaultPauseNoticeDeps(client),
): Promise<void> {
    const { notice_channel_id: channelId, notice_message_id: messageId } = pause;
    if (!channelId || !messageId) return;
    try {
        const user = await deps.getUserById(userId);
        if (!user) return;
        const link = new ButtonBuilder()
            .setStyle(ButtonStyle.Link)
            .setLabel("View notification")
            .setURL(`https://discord.com/channels/${user.guild_id}/${channelId}/${messageId}`);
        await deps.send(channelId, {
            content: `<@${user.discord_user_id}> You have a pending notification for your macro channel!`,
            components: [new ActionRowBuilder<ButtonBuilder>().addComponents(link)],
            allowedMentions: { users: [user.discord_user_id] },
        });
    } catch (err) {
        logger.warn(`Could not send the reminder of pause ${pause.id}`, { error: err instanceof Error ? err.message : String(err) });
    }
}

/** Tells the server's log channel that a member dismissed a pause Notice. */
export async function reportDismissedPause(client: BotClient, { pause, discordUserId, guildId }: MemberPause): Promise<void> {
    const by = pause.by_discord_id ? ` (paused by <@${pause.by_discord_id}>)` : "";
    await guildLog(client, guildId, {
        kind: "warning",
        title: "⚠️ Pause dismissed",
        body: `<@${discordUserId}> dismissed the pause Notice${by}:\n> ${(pause.message ?? "").replaceAll("\n", "\n> ")}`,
    });
}
