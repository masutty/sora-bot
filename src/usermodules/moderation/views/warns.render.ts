import { thresholdLabel } from "../services/ladder";
import type { CaseRow, Threshold } from "../types";
import { caseLine } from "./case.render";

/** `warns <user>`: active warns, their total weight and the member's current Threshold (the highest one reached). */
export function warnsText(userId: string, warns: CaseRow[], ladder: Threshold[]): string {
    const total = warns.reduce((sum, w) => sum + w.weight, 0);
    const reached = ladder.filter((t) => t.warns <= total).at(-1);
    const lines = [`**Active warns of <@${userId}>**`, `-# Weight ${total}`];
    if (reached) lines.push(`Threshold: ${thresholdLabel(reached)}`);
    lines.push("", ...(warns.length === 0 ? ["None."] : warns.map(caseLine)));
    return lines.join("\n");
}
