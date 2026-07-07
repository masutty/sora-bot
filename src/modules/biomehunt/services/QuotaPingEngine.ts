import type { BotClient } from "@/core/BotClient";
import { Logger } from "@/utils/logging";
import { getMacroChannelByUserId, getUserById } from "../repository/users";

const logger = new Logger("biomehunt.QuotaPingEngine");

/** Posts a "you just met the quota" ping to a user's macro channel, if they still have one. */
export async function pingQuotaMet(client: BotClient, userId: number, roleId: string): Promise<void> {
    const user = await getUserById(userId);
    if (!user) return;

    const macroChannel = await getMacroChannelByUserId(userId);
    if (!macroChannel) return;

    const channel = await client.channels.fetch(macroChannel.channel_id).catch(() => null);
    if (!channel || channel.isDMBased() || !channel.isTextBased()) return;

    try {
        await channel.send(`🎉 <@${user.discord_user_id}> just met the quota for <@&${roleId}>!`);
    } catch (err) {
        logger.error(err instanceof Error ? err : new Error(String(err)), { userId, roleId });
    }
}
