import {
    ActionRowBuilder,
    type ButtonBuilder,
    ButtonStyle,
    ChannelType,
    ContainerBuilder,
    MessageFlags,
    SeparatorSpacingSize,
} from "discord.js";
import { paginationRow, type RenderKit, type ViewRender } from "@/define";
import { type FormattedReply, NO_PINGS } from "@/utils/format";
import type { PostStatus } from "../services/post-status";
import type { TrackerOverview } from "../services/tracker-config.service";
import { settings } from "../settings";
import type { GuildBadgeRow } from "../types";
import type { TrackerViewState } from "./settings.view";

const BADGES_PER_PAGE = settings.ui.badgesPerPage;

export const badgePages = (o: TrackerOverview) => Math.max(1, Math.ceil(o.badges.length / BADGES_PER_PAGE));

type Parts = Array<ContainerBuilder | ActionRowBuilder<ButtonBuilder>>;

function newContainer(color = 0x5865f2): { container: ContainerBuilder; divider: () => void } {
    const container = new ContainerBuilder().setAccentColor(color);
    return {
        container,
        divider: () => container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small)),
    };
}

const row = (...buttons: ButtonBuilder[]) => new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);

/** Cuts a text to `max` characters with "…" and flattens line breaks, so it fits in one subtext line. */
export function cut(text: string, max: number): string {
    const flat = text.replace(/\s*\n\s*/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const robloxLink = (id: string) => `[View on Roblox](https://www.roblox.com/badges/${id})`;

const awarded = (count: number | string | null) => (count === null ? null : `Awarded ${Number(count).toLocaleString("en-US")} times`);

const intervalLine = (minutes: number) => `Every ${minutes} minute${minutes === 1 ? "" : "s"}, for all servers`;

const INTRO = "**Badge Tracker**\nPosts in the channel below when a tracked badge gets new awards.";

export const FIRST_RUN = "No badges yet. Add one with its ID or its Roblox link.";

const cantPostLine = (channelId: string) => `⚠️ I can't post in <#${channelId}>. Updates are paused until I can send messages there.`;

/** One badge on the overview: its name, then its ID and what it pings. A deleted badge says so instead. */
export function badgeText(b: GuildBadgeRow): string {
    const detail = b.deleted ? "⚠️ deleted on Roblox" : b.ping_role_id ? `pings <@&${b.ping_role_id}>` : "no ping";
    return `**${b.name}**\n-# ${b.badge_id} · ${detail}`;
}

const badgesHeading = (o: TrackerOverview) =>
    o.badges.length === 0 ? `**Badges**\n${FIRST_RUN}` : `**Badges** (${o.badges.length} of ${settings.limits.perGuild})`;

function overviewScreen(s: TrackerViewState, kit: RenderKit): Parts {
    const o = s.overview;
    const { container, divider } = newContainer();
    container.addTextDisplayComponents((td) => td.setContent(INTRO));
    divider();
    container.addTextDisplayComponents((td) => td.setContent("**Channel**"));
    container.addActionRowComponents(
        kit.row(
            kit.channelSelect("channel", (c) => {
                c.setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                    .setMinValues(0)
                    .setMaxValues(1)
                    .setPlaceholder("Pick a channel");
                return o.channelId ? c.setDefaultChannels(o.channelId) : c;
            }),
        ),
    );
    if (o.channelId && s.status === "no_permission") {
        const warning = cantPostLine(o.channelId);
        container.addTextDisplayComponents((td) => td.setContent(warning));
    }
    container.addSectionComponents((section) =>
        section
            .addTextDisplayComponents((td) => td.setContent(`**Check interval**\n${intervalLine(o.intervalMinutes)}`))
            .setButtonAccessory(kit.button("interval", (b) => b.setLabel("Change").setStyle(ButtonStyle.Secondary))),
    );
    divider();
    container.addTextDisplayComponents((td) => td.setContent(badgesHeading(o)));
    o.badges.slice(s.page * BADGES_PER_PAGE, (s.page + 1) * BADGES_PER_PAGE).forEach((badge, slot) => {
        container.addSectionComponents((section) =>
            section
                .addTextDisplayComponents((td) => td.setContent(badgeText(badge)))
                .setButtonAccessory(kit.button(`edit:${slot}`, (b) => b.setLabel("Edit").setStyle(ButtonStyle.Secondary))),
        );
    });
    const parts: Parts = [container, row(kit.button("add", (b) => b.setLabel("Add badge").setStyle(ButtonStyle.Success)))];
    const pages = badgePages(o);
    if (pages > 1) parts.push(paginationRow(kit, s.page, pages));
    return parts;
}

function previewScreen(s: TrackerViewState, kit: RenderKit): Parts {
    const p = s.preview;
    if (!p) return overviewScreen(s, kit);
    const { badge } = p;
    const { container, divider } = newContainer();
    const lines = [`## ${badge.name}`];
    if (badge.description.trim()) lines.push(`-# ${cut(badge.description, settings.limits.descriptionMax)}`);
    lines.push(awarded(badge.awardedCount) ?? "", `-# ID ${badge.id} · ${robloxLink(badge.id)}`);
    const content = lines.filter(Boolean).join("\n");
    const iconUrl = p.iconUrl;
    if (iconUrl) {
        container.addSectionComponents((section) =>
            section.addTextDisplayComponents((td) => td.setContent(content)).setThumbnailAccessory((t) => t.setURL(iconUrl)),
        );
    } else {
        container.addTextDisplayComponents((td) => td.setContent(content));
    }
    divider();
    container.addTextDisplayComponents((td) => td.setContent("Who gets pinged when it's awarded?"));
    container.addActionRowComponents(
        kit.row(
            kit.roleSelect("previewRole", (r) => {
                r.setMinValues(0).setMaxValues(1).setPlaceholder("No ping");
                return s.previewRoleId ? r.setDefaultRoles(s.previewRoleId) : r;
            }),
        ),
    );
    return [
        container,
        row(
            kit.button("track", (b) => b.setLabel("Track badge").setStyle(ButtonStyle.Success)),
            kit.button("cancel", (b) => b.setLabel("Cancel").setStyle(ButtonStyle.Secondary)),
        ),
    ];
}

function editorScreen(s: TrackerViewState, kit: RenderKit): Parts {
    const badge = s.overview.badges.find((b) => b.badge_id === s.badgeId);
    if (!badge) return overviewScreen(s, kit);
    const { container, divider } = newContainer();
    const idLine = badge.deleted ? `-# ID ${badge.badge_id}` : `-# ID ${badge.badge_id} · ${robloxLink(badge.badge_id)}`;
    const content = [`## ${badge.name}`, awarded(badge.awarded_count), idLine].filter(Boolean).join("\n");
    const iconUrl = badge.icon_url;
    if (iconUrl) {
        container.addSectionComponents((section) =>
            section.addTextDisplayComponents((td) => td.setContent(content)).setThumbnailAccessory((t) => t.setURL(iconUrl)),
        );
    } else {
        container.addTextDisplayComponents((td) => td.setContent(content));
    }
    divider();
    if (badge.deleted) {
        container.addTextDisplayComponents((td) => td.setContent("⚠️ This badge was deleted on Roblox, so it's no longer checked."));
    } else {
        const custom = badge.custom_description?.trim();
        const shown = cut(custom || badge.description, settings.limits.descriptionMax) || "-# None";
        container.addSectionComponents((section) =>
            section
                .addTextDisplayComponents((td) => td.setContent(`**Description**${custom ? " (custom)" : ""}\n${shown}`))
                .setButtonAccessory(kit.button("editDescription", (b) => b.setLabel("Edit").setStyle(ButtonStyle.Secondary))),
        );
        container.addTextDisplayComponents((td) => td.setContent("**Ping role**"));
        container.addActionRowComponents(
            kit.row(
                kit.roleSelect("editRole", (r) => {
                    r.setMinValues(0).setMaxValues(1).setPlaceholder("No ping");
                    return badge.ping_role_id ? r.setDefaultRoles(badge.ping_role_id) : r;
                }),
            ),
        );
    }
    return [
        container,
        row(
            kit.button("back", (b) => b.setLabel("Back").setStyle(ButtonStyle.Secondary)),
            kit.button("remove", (b) => b.setLabel("Remove").setStyle(ButtonStyle.Danger)),
        ),
    ];
}

const SCREENS = { overview: overviewScreen, preview: previewScreen, editor: editorScreen } as const;

export function renderTrackerSettings(s: TrackerViewState, kit: RenderKit): ViewRender {
    return { flags: MessageFlags.IsComponentsV2, components: SCREENS[s.screen](s, kit), allowedMentions: NO_PINGS };
}

/** `/badgetracker list`: the overview as plain text, with no controls. */
export function renderOverviewReadOnly(o: TrackerOverview, status: PostStatus): FormattedReply {
    const { container, divider } = newContainer();
    container.addTextDisplayComponents((td) => td.setContent(INTRO));
    divider();
    const channel = o.channelId ? `<#${o.channelId}>` : "Not set";
    container.addTextDisplayComponents((td) => td.setContent(`**Channel**\n${channel}`));
    if (o.channelId && status === "no_permission") {
        const warning = cantPostLine(o.channelId);
        container.addTextDisplayComponents((td) => td.setContent(warning));
    }
    container.addTextDisplayComponents((td) => td.setContent(`**Check interval**\n${intervalLine(o.intervalMinutes)}`));
    divider();
    container.addTextDisplayComponents((td) => td.setContent(badgesHeading(o)));
    if (o.badges.length > 0) container.addTextDisplayComponents((td) => td.setContent(o.badges.map(badgeText).join("\n")));
    return { flags: MessageFlags.IsComponentsV2, components: [container], allowedMentions: NO_PINGS };
}
