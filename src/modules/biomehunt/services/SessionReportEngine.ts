import { ContainerBuilder, MessageFlags, SeparatorSpacingSize } from "discord.js";
import type { BotClient } from "@/core/BotClient";
import { formatCodeblock, formatTime } from "@/utils/format";
import { Logger } from "@/utils/logging";
import type { ActivitySessionRow } from "../types";
import { getBiomeCountsInRange, getLatestSessionForUser } from "../repository/activity";
import { getMacroChannelByUserId } from "../repository/users";
import { formatBiomeName, getBiomeAnsiColor } from "../types";

const logger = new Logger("biomehunt.SessionReportEngine");

function addDivider(container: ContainerBuilder): void {
    container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
}

const ANSI_RESET = "\u001b[0m";

/** Per-biome ANSI color, from `BIOME_META[biome].ansiColor` - see that file to add/change one. */
function ansiBiomeLine(biome: string, count: number): string {
    return `${getBiomeAnsiColor(biome)}${formatBiomeName(biome)}${ANSI_RESET}: ${count}`;
}

/** Builds the "Session Ended" report Container - split out from `reportSessionEnd` so it can be
 * previewed with fake data (see `tests/embed/session-end.ts`) without a real session in the DB. */
export function buildSessionEndContainer(session: ActivitySessionRow, biomes: Array<{ biome: string; count: number }>): ContainerBuilder {
    const container = new ContainerBuilder().setAccentColor(0x5865f2);

    container.addTextDisplayComponents((td) => td.setContent("## 🕐 Session Ended"));
    container.addTextDisplayComponents((td) => td.setContent(`*${formatTime(session.duration_seconds)} active*`));

    addDivider(container);

    const biomesBody = biomes.length > 0
        ? formatCodeblock(biomes.map((b) => ansiBiomeLine(b.biome, b.count)).join("\n"), "ansi")
        : "*No biomes recorded.*";
    container.addTextDisplayComponents((td) => td.setContent(`**Biomes found**\n${biomesBody}`));

    return container;
}

/** Posts a summary of a user's just-finished session (duration + biome breakdown) to their macro channel. */
export async function reportSessionEnd(client: BotClient, userId: number): Promise<void> {
    const session = await getLatestSessionForUser(userId);
    if (!session) return;

    const macroChannel = await getMacroChannelByUserId(userId);
    if (!macroChannel) return;

    const channel = await client.channels.fetch(macroChannel.channel_id).catch(() => null);
    if (!channel || channel.isDMBased() || !channel.isTextBased()) return;

    const biomes = await getBiomeCountsInRange(userId, session.started_at, session.ended_at);
    const container = buildSessionEndContainer(session, biomes);

    try {
        await channel.send({ flags: MessageFlags.IsComponentsV2, components: [container] });
    } catch (err) {
        logger.error(err instanceof Error ? err : new Error(String(err)), { userId });
    }
}
