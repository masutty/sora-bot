import type { Client, MessageCreateOptions } from "discord.js";
import { ContainerBuilder, MessageFlags, SeparatorSpacingSize } from "discord.js";
import { Logger } from "@/utils/logging";
import { getMemberNetworkGuilds } from "../repository/network.repository";

const logger = new Logger("biomehunt.services.network-announce");

/** Informative sky blue (same as `EmbedFormatter.info`) - never reads as a biome post or a warning. */
const ANNOUNCE_COLOR = 0x0ea5e9;

export interface AnnounceDeps {
    getMemberNetworkGuilds: typeof getMemberNetworkGuilds;
    /** `false` if the channel is gone or the send failed. Must never throw. */
    send: (channelId: string, payload: MessageCreateOptions) => Promise<boolean>;
}

export function defaultAnnounceDeps(client: Client): AnnounceDeps {
    return {
        getMemberNetworkGuilds,
        send: async (channelId, payload) => {
            try {
                const channel = await client.channels.fetch(channelId);
                if (!channel || channel.isDMBased() || !channel.isTextBased()) return false;
                await channel.send(payload);
                return true;
            } catch (err) {
                logger.warn(`Could not send a Network announcement to channel ${channelId}`, {
                    error: err instanceof Error ? err.message : String(err),
                });
                return false;
            }
        },
    };
}

/**
 * The announcement card (also the preview the owner confirms): just the notice, in an informative
 * blue, with a small footer saying where it comes from. `roleId` is the receiving server's
 * announcements role, pinged above the notice.
 */
export function buildAnnouncementContainer(text: string, roleId: string | null = null): ContainerBuilder {
    const container = new ContainerBuilder().setAccentColor(ANNOUNCE_COLOR);
    if (roleId) container.addTextDisplayComponents((td) => td.setContent(`<@&${roleId}>`));
    container.addTextDisplayComponents((td) => td.setContent(text));
    container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    container.addTextDisplayComponents((td) => td.setContent("-# 📢 Network announcement · from: Network maintainers"));
    return container;
}

/** Posts `text` to every Member Server's Network channel, pinging each one's announcements role (if set). */
export async function sendNetworkAnnouncement(text: string, deps: AnnounceDeps): Promise<{ sent: number; total: number }> {
    const targets = (await deps.getMemberNetworkGuilds()).filter((g) => g.network_channel_id);
    let sent = 0;
    for (const guild of targets) {
        const roleId = guild.announce_role_id;
        const ok = await deps.send(guild.network_channel_id as string, {
            components: [buildAnnouncementContainer(text, roleId)],
            flags: MessageFlags.IsComponentsV2,
            allowedMentions: { parse: [], roles: roleId ? [roleId] : [] },
        });
        if (ok) sent++;
    }
    return { sent, total: targets.length };
}
