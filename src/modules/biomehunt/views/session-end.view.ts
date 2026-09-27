import { ContainerBuilder, SeparatorSpacingSize } from "discord.js";
import { formatCodeblock, formatTime } from "@/utils/format";
import { formatBiomeName, getBiomeAnsiColor } from "../constants/biomes.constants";
import type { ActivitySessionRow } from "../types";

function addDivider(container: ContainerBuilder): void {
    container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
}

const ANSI_RESET = "\u001b[0m";

/** Per-biome ANSI color, from `BIOME_META[biome].ansiColor` - see that file to add/change one. */
function ansiBiomeLine(biome: string, count: number): string {
    return `${getBiomeAnsiColor(biome)}${formatBiomeName(biome)}${ANSI_RESET}: ${count}`;
}

/** Builds the "Session Ended" report Container - a pure builder (no interactive View) so it can be
 * previewed with fake data (see `tests/embed/session-end.ts`) without a real session in the DB.
 * `reportSessionEnd` (`services/activity-session-report.service.ts`) is the only caller in prod. */
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
