import {
    ContainerBuilder,
    escapeMarkdown,
    type MessageCreateOptions,
    MessageFlags,
    SectionBuilder,
    SeparatorSpacingSize,
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
    /** The awarded count now; the count before is `total - delta`. */
    total: number;
    window: CheckWindow;
    pingRoleId: string | null;
    /** The Subscription's own accent; `null` = {@link AWARD_COLOR}. */
    accentColor: number | null;
    /** A test post from `/badgetracker test`: marked as such above the card. */
    test?: boolean;
}

const fmt = (n: number) => n.toLocaleString("en-US");
const unix = (d: Date) => Math.floor(d.getTime() / 1000);

/** The custom text wins over Roblox's; blank on both sides gives `null`. Cut to the max length with "…". */
export function resolveDescription(custom: string | null, roblox: string): string | null {
    const text = custom?.trim() || roblox.trim();
    if (!text) return null;
    const max = settings.limits.descriptionMax;
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The text blocks beside the icon - a Section when there's an icon, plain TextDisplays otherwise. */
function addTop(container: ContainerBuilder, blocks: string[], iconUrl: string | null): void {
    const texts = blocks.map((content) => new TextDisplayBuilder().setContent(content));
    if (iconUrl) {
        container.addSectionComponents(
            new SectionBuilder()
                .addTextDisplayComponents(...texts)
                .setThumbnailAccessory(new ThumbnailBuilder({ media: { url: iconUrl } })),
        );
    } else {
        container.addTextDisplayComponents(...texts);
    }
}

/** A divider, then `content` at full width (under the icon). */
function addBelow(container: ContainerBuilder, content: string): void {
    container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(content));
}

/**
 * The test mark and the ping go above the card, so they never change its size. Beside the icon:
 * the linked name and a `diff` block with the new awards (green) and before → now. Under it, each
 * after a divider: the description, then the span the awards came in.
 */
export function buildAwardPost(input: AwardPostInput): MessageCreateOptions {
    const above: string[] = [];
    if (input.test) above.push(TEST_LINE);
    if (input.pingRoleId) above.push(`<@&${input.pingRoleId}>`);

    const title = `## [${escapeMarkdown(input.name)}](https://www.roblox.com/badges/${input.badgeId})`;
    const awards = [
        "```diff",
        `+${fmt(input.delta)} ${input.delta === 1 ? "award" : "awards"}`,
        `  ${fmt(input.total - input.delta)} → ${fmt(input.total)}`,
        "```",
    ].join("\n");
    const post = new ContainerBuilder().setAccentColor(input.accentColor ?? AWARD_COLOR);
    addTop(post, [title, awards], input.iconUrl);

    const descLines = (input.description ?? "")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    if (descLines.length > 0) addBelow(post, descLines.map((l) => `-# ${l}`).join("\n"));
    const { from, to } = input.window;
    addBelow(post, `-# <t:${unix(from)}:t> to <t:${unix(to)}:t> • <t:${unix(to)}:R>`);

    return {
        components: above.length > 0 ? [new TextDisplayBuilder().setContent(above.join("\n")), post] : [post],
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: { parse: [], roles: input.pingRoleId ? [input.pingRoleId] : [] },
    };
}

export const TEST_LINE = "**🧪 Test - not a real award**";

/** What a Subscription's post looks like, with +1 award over the last interval and never a ping. */
export function buildTestPost(row: GuildBadgeRow, intervalMinutes: number, now: Date = new Date()): MessageCreateOptions {
    return buildAwardPost({
        badgeId: row.badge_id,
        name: row.name,
        description: resolveDescription(row.custom_description, row.description),
        iconUrl: row.icon_url,
        delta: 1,
        total: row.awarded_count === null ? 1 : Number(row.awarded_count),
        window: { from: new Date(now.getTime() - intervalMinutes * 60_000), to: now },
        pingRoleId: null,
        accentColor: row.accent_color,
        test: true,
    });
}

export function buildDeletedPost(input: { name: string; lastCount: number | null; iconUrl: string | null }): MessageCreateOptions {
    const lines = [`## ${escapeMarkdown(input.name)}`, "This badge was deleted on Roblox and is no longer tracked here."];
    if (input.lastCount !== null) lines.push(`Last count: ${fmt(input.lastCount)}`);
    const post = new ContainerBuilder().setAccentColor(DELETED_COLOR);
    addTop(post, [lines.join("\n")], input.iconUrl);
    return {
        components: [post],
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: NO_PINGS,
    };
}
