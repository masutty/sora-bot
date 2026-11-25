import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder } from "discord.js";
import type { PauseRow } from "../repository/pauses.repository";

export const PAUSE_NOTICE_PREFIX = "biomehunt:pause-notice";

/** The Notice: the admin's message and a single `Resolved` button that ends the pause. */
export function buildPauseNoticeContainer(pause: PauseRow, discordUserId: string): ContainerBuilder {
    return new ContainerBuilder()
        .setAccentColor(0xf0b232)
        .addTextDisplayComponents((td) => td.setContent(`<@${discordUserId}>\n${pause.message ?? ""}`))
        .addActionRowComponents(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId(`${PAUSE_NOTICE_PREFIX}:${pause.id}`).setLabel("Resolved").setStyle(ButtonStyle.Success),
            ),
        );
}
