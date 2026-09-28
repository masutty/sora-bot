import { ContainerBuilder, MessageFlags } from "discord.js";
import { EmbedFormatter, type FormattedReply, NO_PINGS } from "@/utils/format";
import { getLevelForXp } from "../constants/levels.constants";

export interface Balance {
    seeds: number;
    xp: number;
}

/**
 * `/bh balance` reply - a pure builder (no I/O). `balance` null = the target has no profile.
 * Always NO_PINGS: checking someone's balance must never notify them.
 */
export function buildBalanceReply(targetId: string, isSelf: boolean, balance: Balance | null): FormattedReply {
    if (!balance) {
        const reply = isSelf
            ? EmbedFormatter.info("You don't have a profile yet!\n\nRun `/bh setup` to get started.")
            : EmbedFormatter.info(`<@${targetId}> doesn't have a profile yet.`);
        return { ...reply, allowedMentions: NO_PINGS };
    }

    const { level, currentLevelXp, nextLevelXp } = getLevelForXp(balance.xp);
    const container = new ContainerBuilder().setAccentColor(0x5865f2);
    container.addTextDisplayComponents((td) => td.setContent(`### ${isSelf ? "Your balance" : `<@${targetId}>'s balance`}`));
    container.addTextDisplayComponents((td) =>
        td.setContent(
            [`🌱 Seeds: ${balance.seeds}`, `-# Level ${level} (${balance.xp - currentLevelXp}/${nextLevelXp - currentLevelXp} XP)`].join(
                "\n",
            ),
        ),
    );
    return { components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: NO_PINGS };
}
