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

const AWARD_COLOR = 0x3ba55d;
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
    if (input.pingRoleId) lines.push(`<@&${input.pingRoleId}>`);
    lines.push(`## [${escapeMarkdown(input.name)}](https://www.roblox.com/badges/${input.badgeId})`);
    if (input.description) lines.push(...input.description.split("\n").map((l) => `-# ${l}`));
    lines.push(`**+${fmt(input.delta)}** ${input.delta === 1 ? "award" : "awards"} ${windowText(input.window)}`);
    lines.push(`${fmt(input.total)} total`);

    return {
        components: [card(lines.join("\n"), input.iconUrl, AWARD_COLOR)],
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: { parse: [], roles: input.pingRoleId ? [input.pingRoleId] : [] },
    };
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
