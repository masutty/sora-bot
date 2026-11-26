import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import type { CaseKind, CaseRow } from "../types";

/** The component prefix: customIds read `moderation:undo:<caseId>:<postedAt>`. */
export const UNDO_PREFIX = "moderation:undo";
export const UNDO_WINDOW_S = 12 * 60 * 60;

/** The kinds a Case Channel post can undo, with the button label. */
export const UNDO_LABELS: Partial<Record<CaseKind, string>> = {
    warn: "Revoke",
    mute: "Unmute",
    ban: "Unban",
    temprole: "Remove role",
};

export const undoCustomId = (caseId: string, postedAt: number): string => `${UNDO_PREFIX}:${caseId}:${postedAt}`;

/** The `parts` the router gives after the prefix; `null` when malformed. */
export function parseUndoParts(parts: string[]): { caseId: string; postedAt: number } | null {
    const [caseId, stamp] = parts;
    const postedAt = Number(stamp);
    if (!caseId || parts.length !== 2 || !Number.isInteger(postedAt)) return null;
    return { caseId, postedAt };
}

/** The action row of a "Created" post; `null` for kinds that cannot be undone. */
export function undoRow(row: CaseRow, postedAt: number): ActionRowBuilder<ButtonBuilder> | null {
    const label = UNDO_LABELS[row.kind];
    if (!label) return null;
    const button = new ButtonBuilder().setCustomId(undoCustomId(row.id, postedAt)).setLabel(label).setStyle(ButtonStyle.Danger);
    return new ActionRowBuilder<ButtonBuilder>().addComponents(button);
}
