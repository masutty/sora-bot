import {
    ContainerBuilder,
    escapeMarkdown,
    type MessageCreateOptions,
    MessageFlags,
    SectionBuilder,
    TextDisplayBuilder,
    ThumbnailBuilder,
} from "discord.js";
import { NO_PINGS } from "@/utils/format";
import type { CheckWindow } from "../services/award-delta";
import { settings } from "../settings";
import type { GuildBadgeRow } from "../types";

export const AWARD_COLOR = 0x3ba55d;
const DELETED_COLOR = 0xda373c;

export interface AwardPostInput {
    badgeId: string;
    name: string;
    description: string | null;
    iconUrl: string | null;
    delta: number;
    total: number;
    window: CheckWindow;
    pingRoleId: string | null;
    /** The Subscription's own accent; `null` = {@link AWARD_COLOR}. */
    accentColor: number | null;
    /** A test post from `/badgetracker test`: marked as such on the first line. */
    test?: boolean;
}

const fmt = (n: number) => n.toLocaleString("en-US");

/** The custom text wins over Roblox's; blank on both sides gives `null`. Cut to the max length with "…". */
export function resolveDescription(custom: string | null, roblox: string): string | null {
    const text = custom?.trim() || roblox.trim();
    if (!text) return null;
    const max = settings.limits.descriptionMax;
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function windowText(window: CheckWindow): string {
    if (window.kind === "since") return `since <t:${Math.floor(window.at.getTime() / 1000)}:t>`;
    return window.minutes === 1 ? "in the last minute" : `in the last ${window.minutes} minutes`;
}

/** One card: a Section (text plus thumbnail) or, without an icon, a plain TextDisplay. */
function card(text: string, iconUrl: string | null, color: number): ContainerBuilder {
    const container = new ContainerBuilder().setAccentColor(color);
    if (iconUrl) {
        container.addSectionComponents(
            new SectionBuilder()
                .addTextDisplayComponents(new TextDisplayBuilder().setContent(text))
                .setThumbnailAccessory(new ThumbnailBuilder({ media: { url: iconUrl } })),
        );
    } else {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
    }
    return container;
}

export function buildAwardPost(input: AwardPostInput): MessageCreateOptions {
    const lines: string[] = [];
    if (input.test) lines.push(TEST_LINE);
    if (input.pingRoleId) lines.push(`<@&${input.pingRoleId}>`);
    lines.push(`## [${escapeMarkdown(input.name)}](https://www.roblox.com/badges/${input.badgeId})`);
    if (input.description) {
        const descLines = input.description
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l.length > 0);
        lines.push(...descLines.map((l) => `-# ${l}`));
    }
    lines.push(`**+${fmt(input.delta)}** ${input.delta === 1 ? "award" : "awards"} ${windowText(input.window)}`);
    lines.push(`${fmt(input.total)} total`);

    return {
        components: [card(lines.join("\n"), input.iconUrl, input.accentColor ?? AWARD_COLOR)],
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: { parse: [], roles: input.pingRoleId ? [input.pingRoleId] : [] },
    };
}

export const TEST_LINE = "**🧪 Test - not a real award**";

/** What a Subscription's post looks like, with +1 award and never a ping. */
export function buildTestPost(row: GuildBadgeRow, intervalMinutes: number): MessageCreateOptions {
    return buildAwardPost({
        badgeId: row.badge_id,
        name: row.name,
        description: resolveDescription(row.custom_description, row.description),
        iconUrl: row.icon_url,
        delta: 1,
        total: row.awarded_count === null ? 1 : Number(row.awarded_count),
        window: { kind: "interval", minutes: intervalMinutes },
        pingRoleId: null,
        accentColor: row.accent_color,
        test: true,
    });
}

export function buildDeletedPost(input: { name: string; lastCount: number | null; iconUrl: string | null }): MessageCreateOptions {
    const lines = [`## ${escapeMarkdown(input.name)}`, "This badge was deleted on Roblox and is no longer tracked here."];
    if (input.lastCount !== null) lines.push(`Last count: ${fmt(input.lastCount)}`);
    return {
        components: [card(lines.join("\n"), input.iconUrl, DELETED_COLOR)],
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: NO_PINGS,
    };
}
