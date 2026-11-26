import { ContainerBuilder, MessageFlags } from "discord.js";
import { cut, EmbedFormatter, type FormattedReply, NO_PINGS, unix } from "@/utils/format";
import { actionLine, capital, detailBullets, fullStamp, reasonSection, sectionedContainer } from "../services/payloads";
import { settings } from "../settings";
import type { CaseEventRow, CaseRow } from "../types";

/** A plain-text reply with the accent color that never pings. */
export const plainReply = (text: string): FormattedReply => ({
    components: [new ContainerBuilder().setAccentColor(settings.accentColor).addTextDisplayComponents((td) => td.setContent(text))],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: NO_PINGS,
});

const status = (row: CaseRow): string => (row.ended_at ? (row.end_reason ?? "ended") : "active");

/** One Case in a list: ID, kind and status, then the short reason and when. */
export function caseLine(row: CaseRow): string {
    const weight = row.kind === "warn" && row.weight > 1 ? ` ${row.weight}x` : "";
    const reason = cut(row.reason.replace(/\s+/g, " "), 120);
    return `- \`${row.id}\` **${capital(row.kind)}**${weight} (${status(row)})\n> ${reason}\n> <t:${unix(row.created_at)}:R>`;
}

const by = (id: string | null) => (id ? `<@${id}>` : "Auto");

const EVENT_NAMES: Record<CaseEventRow["kind"], string> = {
    created: "Created",
    revoked: "Revoked",
    expired: "Expired",
    replaced: "Replaced",
    reason_changed: "Reason changed",
    auto_undone: "Auto-undone",
};

function accent(row: CaseRow): number {
    if (row.ended_at) return settings.endedColor;
    if (row.kind === "warn") return settings.warnColor;
    return row.kind === "temprole" ? settings.accentColor : settings.punishColor;
}

/** Under the title: the status, and who revoked the Case when someone did. */
function statusLine(row: CaseRow): string {
    if (row.end_reason === "revoked" && row.ended_by) return `Revoked by <@${row.ended_by}>`;
    return capital(status(row));
}

/** `case <id>`: who did what to whom, the reason, the details, then the event history (oldest first). */
export function caseDetailReply(row: CaseRow, events: CaseEventRow[]): FormattedReply {
    const history = ["**History**"];
    for (const event of events) {
        history.push(`- ${EVENT_NAMES[event.kind]} by ${by(event.by_id)}`, `> <t:${unix(event.at)}:R>`);
        if (typeof event.data.note === "string") history.push(`> **Reason:** ${cut(event.data.note, 100)}`);
    }

    const header = `**${capital(row.kind)}** \`${row.id}\`
-# ${statusLine(row)}
${actionLine(row)}`;
    const container = sectionedContainer(accent(row), [
        header,
        reasonSection(row),
        detailBullets(row, fullStamp(row.created_at)),
        history.join("\n"),
    ]);
    return { components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: NO_PINGS };
}

export interface Confirmation {
    /** The first line without the check mark and the case: `**Muted** <@id> for 30m`. */
    summary: string;
    /** `null` when no case was touched. */
    caseId: string | null;
    reason: string;
    /** The member could not be DMed about the case. */
    dmFailed?: boolean;
    /** Extra subtext lines. */
    notes?: string[];
}

/** The staff-facing confirmation of an action - the one place to change its style. */
export function confirmation({ summary, caseId, reason, dmFailed = false, notes = [] }: Confirmation): FormattedReply {
    const lines = [`✅ ${summary}${caseId ? ` (\`${caseId}\`)` : ""}`, `> **Reason:** ${cut(reason, 300)}`];
    if (dmFailed) lines.push("-# I couldn't DM this user, so they weren't told about this case.");
    for (const note of notes) lines.push(`-# ${cut(note, 300)}`);
    return { ...EmbedFormatter.success(lines.join("\n"), { emoji: false }), allowedMentions: NO_PINGS };
}
