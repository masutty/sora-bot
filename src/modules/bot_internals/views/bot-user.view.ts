import { ContainerBuilder, SectionBuilder, SeparatorSpacingSize, TextDisplayBuilder, ThumbnailBuilder } from "discord.js";
import type { BotBanRow, BotNoteRow, BotPunishmentRow } from "@/database/bot-moderation.repository";

const INFO_COLOR = 0x5865f2;
const BANNED_COLOR = 0xf43f5e;

/** The account facts `/bot info` shows - gathered from Discord, never stored. */
export interface AccountInfo {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string;
    createdAt: Date;
    bot: boolean;
    /** Servers the bot shares with them (from its cache). */
    mutualServers: number;
}

type BanState = Pick<BotBanRow, "reason" | "banned_by" | "created_at"> | null;

const epoch = (d: Date) => Math.floor(d.getTime() / 1000);

function banLine(ban: BanState): string {
    if (!ban) return "Not banned";
    const reason = ban.reason ? `\nReason: ${ban.reason}` : "";
    return `**Banned** since <t:${epoch(ban.created_at)}:R> by <@${ban.banned_by}>${reason}`;
}

/** `/bot info`'s "Account" tab. */
export function buildAccountContainer(a: AccountInfo, ban: BanState): ContainerBuilder {
    const container = new ContainerBuilder().setAccentColor(ban ? BANNED_COLOR : INFO_COLOR);
    container.addSectionComponents(
        new SectionBuilder()
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${a.displayName}\n@${a.username} · \`${a.id}\``))
            .setThumbnailAccessory(new ThumbnailBuilder({ media: { url: a.avatarUrl } })),
    );
    container.addSeparatorComponents((s) => s.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    const lines = [
        `Account created: <t:${epoch(a.createdAt)}:D> (<t:${epoch(a.createdAt)}:R>)`,
        `Bot account: ${a.bot ? "yes" : "no"}`,
        `Mutual servers: **${a.mutualServers}**`,
        `Bot ban: ${ban ? "**Banned**" : "Not banned"}`,
    ];
    container.addTextDisplayComponents((td) => td.setContent(lines.join("\n")));
    return container;
}

const ACTION_LABEL: Record<BotPunishmentRow["action"], string> = { ban: "Ban", unban: "Unban" };

/** `/bot info`'s "Punishments" tab: the current ban state, then every ban/unban, newest first. */
export function buildPunishmentsContainer(ban: BanState, history: BotPunishmentRow[]): ContainerBuilder {
    const container = new ContainerBuilder().setAccentColor(ban ? BANNED_COLOR : INFO_COLOR);
    container.addTextDisplayComponents((td) => td.setContent(`## Punishments\n${banLine(ban)}`));
    container.addSeparatorComponents((s) => s.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    const lines = history.map(
        (p) => `- <t:${epoch(p.created_at)}:R> **${ACTION_LABEL[p.action]}** by <@${p.by_user_id}>${p.reason ? ` - ${p.reason}` : ""}`,
    );
    container.addTextDisplayComponents((td) => td.setContent(lines.length > 0 ? lines.join("\n") : "No punishments."));
    return container;
}

/** `/bot notes`: every note about the user, newest first. */
export function buildNotesContainer(discordUserId: string, notes: BotNoteRow[]): ContainerBuilder {
    const container = new ContainerBuilder().setAccentColor(INFO_COLOR);
    container.addTextDisplayComponents((td) => td.setContent(`## Notes about <@${discordUserId}>`));
    container.addSeparatorComponents((s) => s.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    const lines = notes.map((n) => `- \`#${n.id}\` <t:${epoch(n.created_at)}:R> by <@${n.author_id}>\n> ${n.note.replace(/\n/g, "\n> ")}`);
    container.addTextDisplayComponents((td) => td.setContent(lines.length > 0 ? lines.join("\n") : "No notes."));
    return container;
}
