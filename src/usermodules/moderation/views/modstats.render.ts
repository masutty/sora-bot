import type { StaffStatRow } from "../repository/cases.repository";
import type { CaseKind } from "../types";

export interface StatWindow {
    label: string;
    rows: StaffStatRow[];
}

const KINDS: CaseKind[] = ["warn", "mute", "kick", "ban", "softban", "temprole"];

const sum = (rows: StaffStatRow[]) => rows.reduce((total, r) => total + r.count, 0);

function kindsLine(rows: StaffStatRow[]): string {
    const parts = KINDS.map((kind) => [kind, sum(rows.filter((r) => r.kind === kind))] as const)
        .filter(([, count]) => count > 0)
        .map(([kind, count]) => `${count} ${kind}`);
    return parts.length === 0 ? "none" : parts.join(", ");
}

/** `modstats [staff]`: Cases created per kind in each window; Auto-Punishments apart; temprole is not a punishment, so it stays out of the total. */
export function modstatsText(staffId: string | null, windows: StatWindow[]): string {
    const lines = [`**Moderation stats${staffId ? ` of <@${staffId}>` : ""}**`];
    for (const { label, rows } of windows) {
        const staff = rows.filter((r) => !r.bot);
        const auto = rows.filter((r) => r.bot);
        lines.push(`- **${label}:** ${sum(staff.filter((r) => r.kind !== "temprole"))} punishments`, `> ${kindsLine(staff)}`);
        if (auto.length > 0) lines.push(`> Auto: ${kindsLine(auto)}`);
    }
    return lines.join("\n");
}
