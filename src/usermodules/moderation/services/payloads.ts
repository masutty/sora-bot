import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    EmbedBuilder,
    type MessageCreateOptions,
    MessageFlags,
    SeparatorSpacingSize,
} from "discord.js";
import { cut, formatTime, NO_PINGS, unix } from "@/utils/format";
import { settings } from "../settings";
import type { CaseKind, CaseRow } from "../types";
import { undoRow } from "./undo";

export type DmEvent = { type: "punished"; case: CaseRow } | { type: "ended"; case: CaseRow; reason: string };

export interface DmContext {
    guildId: string;
    guildName: string;
    appealLine: string | null;
}

export interface CaseChannelEvent {
    event: "created" | "revoked" | "expired" | "replaced" | "reason_changed" | "auto_undone";
    case: CaseRow;
    /** Who caused the event; `null` is the bot. */
    by: string | null;
    /** The note of the event, shown as a quote. */
    note?: string | null;
    /** When the event happened; defaults to now. */
    at?: Date;
}

const PUNISHED_TITLES: Record<CaseKind, string> = {
    warn: "You got warned",
    mute: "You got muted",
    kick: "You got kicked",
    ban: "You got banned",
    softban: "You got softbanned",
    temprole: "You got a temporary role",
};

const ENDED_TITLES: Partial<Record<CaseKind, string>> = {
    warn: "You got unwarned",
    mute: "You got unmuted",
    ban: "You got unbanned",
    softban: "You got unbanned",
};

const APPEAL_KINDS: ReadonlySet<CaseKind> = new Set(["warn", "mute", "kick", "softban", "ban"]);

/** `<t:X:F> (<t:X:R>)` - full date plus the relative form. */
export function fullStamp(date: Date): string {
    return `<t:${unix(date)}:F> (<t:${unix(date)}:R>)`;
}

/** The DM outcome with its emoji and failure reason; `null` when no DM was attempted. */
export function dmValue(row: CaseRow): string | null {
    if (row.dm_delivered === null) return null;
    if (row.dm_delivered) return "`✅ Delivered`";
    return `\`❌ Not delivered${row.dm_error ? ` (${row.dm_error})` : ""}\``;
}

function punishedLines(row: CaseRow): string[] {
    const lines = [`> **Reason:** ${row.reason}`];
    const span = row.expires_at ? Math.max(1, unix(row.expires_at) - unix(row.created_at)) : null;
    if (row.kind === "warn" && row.expires_at) lines.push(`> **Expires:** ${fullStamp(row.expires_at)}`);
    if (row.kind === "mute" && row.expires_at && span !== null) {
        lines.push(`> **Duration:** ${formatTime(span)}`, `> **Ends:** ${fullStamp(row.expires_at)}`);
    }
    if (row.kind === "ban") lines.push(`> **Duration:** ${span === null ? "Permanent" : formatTime(span)}`);
    return lines;
}

export function dmPayload(event: DmEvent, ctx: DmContext): MessageCreateOptions {
    const row = event.case;
    const title = event.type === "punished" ? PUNISHED_TITLES[row.kind] : (ENDED_TITLES[row.kind] ?? "Case ended");
    const lines = [`**${title} - Case \`${row.id}\`**`];
    let color: number;
    if (event.type === "punished") {
        lines.push(...punishedLines(row));
        if (ctx.appealLine && APPEAL_KINDS.has(row.kind)) lines.push("", `> ${ctx.appealLine}`);
        color = row.kind === "warn" ? settings.warnColor : settings.punishColor;
    } else {
        lines.push(`> **Reason:** ${event.reason}`);
        color = settings.endColor;
    }
    const button = new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel(`From ${ctx.guildName}`.slice(0, 80))
        .setURL(`https://discord.com/channels/${ctx.guildId}`);
    return {
        embeds: [new EmbedBuilder().setColor(color).setDescription(lines.join("\n"))],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)],
        allowedMentions: NO_PINGS,
    };
}

const EVENT_LABELS: Record<CaseChannelEvent["event"], string> = {
    created: "Created",
    revoked: "Revoked",
    expired: "Expired",
    replaced: "Replaced",
    reason_changed: "Reason changed",
    auto_undone: "Auto-undone",
};

const DONE_BY: Record<CaseKind, string> = {
    warn: "warned",
    mute: "muted",
    kick: "kicked",
    ban: "banned",
    softban: "softbanned",
    temprole: "given a temporary role",
};

export const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** `<@member>, <verb> by <moderator|Auto-Punishment>` - shared by `case <id>` and the Case Channel. */
export function actionLine(row: CaseRow): string {
    const moderator = row.moderator_id ? `<@${row.moderator_id}>` : "Auto-Punishment";
    return `<@${row.user_id}>, ${DONE_BY[row.kind]} by ${moderator}`;
}

/** `**Reason**` followed by the Case reason as a block quote. */
export function reasonSection(row: CaseRow): string {
    return `**Reason**
>>> ${row.reason}`;
}

/** The detail bullets; `middle` goes between the expiry and the optional ones. */
export function detailBullets(row: CaseRow, created: string, middle: string[] = []): string {
    const details = [`- **Created:** ${created}`];
    if (row.expires_at) details.push(`- **Expires:** ${fullStamp(row.expires_at)}`);
    details.push(...middle);
    if (row.weight > 1) details.push(`- **Weight:** ${row.weight}x`);
    if (row.role_id) details.push(`- **Role:** <@&${row.role_id}>`);
    if (row.triggered_by) details.push(`- **Triggered by:** \`${row.triggered_by}\``);
    const dm = dmValue(row);
    if (dm) details.push(`- **DM:** ${dm}`);
    return details.join("\n");
}

/** A Container with its text and divider helpers; sections are separated by dividers. */
export function sectionedContainer(color: number, sections: string[]): ContainerBuilder {
    const container = new ContainerBuilder().setAccentColor(color);
    sections.forEach((content, i) => {
        if (i > 0) container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
        container.addTextDisplayComponents((td) => td.setContent(content));
    });
    return container;
}

const BY_EVENTS: ReadonlySet<CaseChannelEvent["event"]> = new Set(["revoked", "reason_changed", "auto_undone"]);

function channelColor(event: CaseChannelEvent): number {
    const kind = event.case.kind;
    switch (event.event) {
        case "revoked":
        case "expired":
        case "replaced":
        case "auto_undone":
            return settings.endColor;
        default:
            return kind === "warn" ? settings.warnColor : kind === "temprole" ? settings.accentColor : settings.punishColor;
    }
}

export function caseChannelPayload(event: CaseChannelEvent): MessageCreateOptions {
    const row = event.case;
    const label = EVENT_LABELS[event.event];
    const eventLine = event.by && BY_EVENTS.has(event.event) ? `${label} by <@${event.by}>` : label;
    const when = event.event === "created" ? [] : [`- **${label}:** <t:${unix(event.at ?? new Date())}:R>`];
    const note = event.note
        ? `
> **Reason:** ${cut(event.note, 100)}`
        : "";
    const sections = [
        `**${capital(row.kind)}** \`${row.id}\`
-# ${eventLine}
${actionLine(row)}`,
        reasonSection(row),
        `${detailBullets(row, `<t:${unix(row.created_at)}:R>`, when)}${note}`,
    ];
    const undo = event.event === "created" ? undoRow(row, unix(row.created_at)) : null;
    return {
        components: [sectionedContainer(channelColor(event), sections), ...(undo ? [undo] : [])],
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: NO_PINGS,
    };
}
