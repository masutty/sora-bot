import { type MessageCreateOptions, MessageFlags } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { Logger } from "@/utils/logging";
import { markNoticeSent, type PauseRow } from "../repository/pauses.repository";
import { getMacroChannelByUserId, getUserById } from "../repository/users.repository";
import { buildPauseNoticeContainer } from "../views/pause-notice.view";
import { describeDiscordError, guildLog } from "./guild-log.service";

const logger = new Logger("biomehunt.services.pause-notice");

/** Database and Discord access, injected so tests use neither. */
export interface PauseNoticeDeps {
    getUserById: typeof getUserById;
    getMacroChannel: typeof getMacroChannelByUserId;
    send(channelId: string, payload: MessageCreateOptions): Promise<void>;
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
            await channel.send(payload);
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
        await deps.send(channel.channel_id, {
            flags: MessageFlags.IsComponentsV2,
            components: [buildPauseNoticeContainer(pause, user.discord_user_id)],
            allowedMentions: { users: [user.discord_user_id] },
        });
        await deps.markNoticeSent(pause.id);
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
