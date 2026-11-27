import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder } from "discord.js";
import { unix } from "@/utils/format";
import type { PauseRow } from "../repository/pauses.repository";

export const PAUSE_NOTICE_PREFIX = "biomehunt:pause-notice";

const WARNING = 0xf0b232;

/** "until you respond" - how a pause ends, as the end of a sentence. */
export function pauseUntilPhrase(pause: PauseRow): string {
    if (pause.until.kind === "session_end") return "until your session ends";
    if (pause.until.kind === "time") return `until <t:${unix(pause.until.at)}:f>`;
    return "until you respond";
}

const quoted = (message: string) =>
    message
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");

function container(color: number, lines: Array<string | null>): ContainerBuilder {
    return new ContainerBuilder()
        .setAccentColor(color)
        .addTextDisplayComponents((td) => td.setContent(lines.filter((line) => line !== null).join("\n")));
}

/**
 * The Notice: what the pause means, the admin's message and, under the container, the buttons -
 * `Understood` ends the pause, `Dismiss` (when allowed) ends it and tells the staff, `Cancel` is
 * the admins'.
 */
export function buildPauseNotice(pause: PauseRow, discordUserId: string): [ContainerBuilder, ActionRowBuilder<ButtonBuilder>] {
    const button = (action: string, label: string, style: ButtonStyle) =>
        new ButtonBuilder().setCustomId(`${PAUSE_NOTICE_PREFIX}:${pause.id}${action}`).setLabel(label).setStyle(style);
    return [
        container(WARNING, [
            `<@${discordUserId}>`,
            `### ⏸️ Your macro channel has been paused ${pauseUntilPhrase(pause)}`,
            pause.counts ? null : "- None of your contributions will count while it is paused",
            quoted(pause.message ?? ""),
        ]),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
            // No action segment: Notices posted before the other buttons existed keep working.
            button("", "Understood", ButtonStyle.Success),
            ...(pause.dismissable ? [button(":dismiss", "Dismiss", ButtonStyle.Secondary)] : []),
            button(":cancel", "Cancel", ButtonStyle.Danger),
        ),
    ];
}

export type PauseOutcome = { kind: "understood" } | { kind: "dismissed" } | { kind: "cancelled"; byDiscordId: string };

/** The Notice once the pause is over: what happened, and the message, with no buttons. */
export function buildClosedPauseNotice(pause: PauseRow, discordUserId: string, outcome: PauseOutcome): ContainerBuilder {
    const [color, title] = {
        understood: [0x248046, "### ✅ Pause ended"],
        dismissed: [0x4e5058, "### Pause dismissed"],
        cancelled: [0x4e5058, "### Pause cancelled"],
    }[outcome.kind] as [number, string];
    return container(color, [
        `<@${discordUserId}>`,
        title,
        outcome.kind === "cancelled" ? `- Cancelled by <@${outcome.byDiscordId}>` : null,
        pause.message ? quoted(pause.message) : null,
    ]);
}

/** The private question behind `Dismiss`. `noticeId` is the Notice message to close afterwards. */
export function buildDismissConfirm(pauseId: number, noticeId: string): [ContainerBuilder, ActionRowBuilder<ButtonBuilder>] {
    return [
        container(WARNING, [
            "### Dismiss this message?",
            "- If you solved the problem, click `Understood` instead",
            "- The staff will be told that you dismissed it",
        ]),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`${PAUSE_NOTICE_PREFIX}:${pauseId}:dismiss-confirm:${noticeId}`)
                .setLabel("Dismiss anyway")
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`${PAUSE_NOTICE_PREFIX}:${pauseId}:dismiss-back`)
                .setLabel("Go back")
                .setStyle(ButtonStyle.Secondary),
        ),
    ];
}

/** A short private answer that replaces the confirmation. */
export const buildPauseReply = (text: string) => container(WARNING, [text]);
