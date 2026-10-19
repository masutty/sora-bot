import {
    ActionRowBuilder,
    type ButtonBuilder,
    ButtonStyle,
    ChannelType,
    ContainerBuilder,
    type GuildMember,
    MessageFlags,
    SeparatorSpacingSize,
} from "discord.js";
import { paginationRow, type RenderKit, type ViewRender } from "@/define";
import { formatTime, NO_PINGS, unix } from "@/utils/format";
import { getAwardableBadges, getBadgeMeta } from "../constants/badges.constants";
import {
    ALL_BIOME_CATEGORIES,
    BIOME_CATEGORY_LABELS,
    formatBiomeName,
    getBiomeColor,
    getBiomeIconUrl,
    getBiomeMeta,
    getEnabledBiomes,
} from "../constants/biomes.constants";
import type { ActivitySessionRow } from "../types";
import type { MemberAdminState } from "./member-admin.view";
import { formatHours } from "./settings.screens";
import {
    buildBiomesTabContainer,
    buildProfileTabContainer,
    buildSessionsTabContainer,
    type ProfileData,
    SESSIONS_PER_PAGE,
} from "./stats-builders";

export const BADGES_PER_PAGE = 5;
/** Discord shows at most this many options in a select. */
const MAX_SELECT_OPTIONS = 25;

export const MEMBER_TABS = [
    { key: "profile", label: "Profile" },
    { key: "biomes", label: "Biomes" },
    { key: "badges", label: "Badges" },
    { key: "sessions", label: "Sessions" },
] as const;

const RED = 0xda373c;
const BLURPLE = 0x5865f2;

type Parts = Array<ContainerBuilder | ActionRowBuilder<ButtonBuilder>>;

const num = (n: number) => n.toLocaleString("en-US");
export const plural = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;

function newContainer(color = BLURPLE): { container: ContainerBuilder; divider: () => void } {
    const container = new ContainerBuilder().setAccentColor(color);
    return {
        container,
        divider: () => container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small)),
    };
}

/** One text block with an accessory button. */
function addRow(container: ContainerBuilder, text: string, button: ButtonBuilder): void {
    container.addSectionComponents((section) => section.addTextDisplayComponents((td) => td.setContent(text)).setButtonAccessory(button));
}

const buttonRow = (...buttons: ButtonBuilder[]) => new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);

/** The sessions the tab lists: the newest one is left out while it is still running. */
export function completedSessions(data: ProfileData): ActivitySessionRow[] {
    return data.user.current_status === "active" ? data.sessions.slice(1) : data.sessions;
}

export const sessionPages = (data: ProfileData) => Math.max(Math.ceil(completedSessions(data).length / SESSIONS_PER_PAGE), 1);

export function sessionsOnPage(data: ProfileData, page: number): ActivitySessionRow[] {
    return completedSessions(data).slice(page * SESSIONS_PER_PAGE, (page + 1) * SESSIONS_PER_PAGE);
}

/** Every badge an admin can give or take, then any earned badge outside that list. */
export function listedBadges(data: ProfileData): string[] {
    const listed = getAwardableBadges();
    return [...listed, ...data.badges.map((b) => b.badge).filter((b) => !listed.includes(b))];
}

export const badgePages = (data: ProfileData) => Math.max(Math.ceil(listedBadges(data).length / BADGES_PER_PAGE), 1);

export function badgeOnPage(data: ProfileData, page: number, slot: number): string | undefined {
    return listedBadges(data)[page * BADGES_PER_PAGE + slot];
}

/** The biomes the edit select offers: the member's finds first, then the rest, within Discord's limit. */
export function editableBiomes(data: ProfileData): string[] {
    const found = [...data.biomes].sort((a, b) => b.count - a.count).map((b) => b.biome);
    const rest = getEnabledBiomes()
        .filter((b) => b.category !== "admin" && !found.includes(b.key))
        .sort((a, b) => ALL_BIOME_CATEGORIES.indexOf(a.category) - ALL_BIOME_CATEGORIES.indexOf(b.category))
        .map((b) => b.key);
    return [...found, ...rest].slice(0, MAX_SELECT_OPTIONS);
}

export const biomeCount = (data: ProfileData, biome: string) => data.biomes.find((b) => b.biome === biome)?.count ?? 0;

function tabRow(s: MemberAdminState, kit: RenderKit): ActionRowBuilder<ButtonBuilder> {
    return buttonRow(
        ...MEMBER_TABS.map((t) =>
            kit.button(`tab:${t.key}`, (b) =>
                b
                    .setLabel(t.label)
                    .setStyle(t.key === s.tab ? ButtonStyle.Primary : ButtonStyle.Secondary)
                    .setDisabled(t.key === s.tab),
            ),
        ),
    );
}

// --- Profile tab ---

function adminBox(s: MemberAdminState, data: ProfileData, kit: RenderKit): ContainerBuilder {
    const { container, divider } = newContainer();
    const channel = s.channel;
    container.addTextDisplayComponents((td) => td.setContent("**Admin**"));
    addRow(
        container,
        `**Macro channel**\n${channel ? `<#${channel.channelId}> · webhook ${channel.webhookWorking ? "working" : "not working"}` : "No channel"}`,
        kit.button("manage", (b) => b.setLabel("Manage")),
    );
    if (s.autoDelete) {
        const paused = data.user.paused_at !== null;
        divider();
        addRow(
            container,
            paused
                ? "**Auto-delete** · paused\nTheir channel is never auto-deleted."
                : `**Auto-delete**\nDeletes the channel ${formatHours(s.deleteAfterS)} after they go inactive.`,
            kit.button(paused ? "resume" : "pause", (b) =>
                b.setLabel(paused ? "Resume" : "Pause").setStyle(paused ? ButtonStyle.Success : ButtonStyle.Secondary),
            ),
        );
    }
    if (data.economyEnabled) {
        divider();
        addRow(
            container,
            `**Seeds & XP**\n\`${num(data.user.seeds)} 🌱\` · \`${num(data.user.xp)} XP\``,
            kit.button("adjust", (b) => b.setLabel("Adjust")),
        );
    }
    divider();
    addRow(
        container,
        "**Danger zone**\nReset or delete this member's data.",
        kit.button("danger", (b) => b.setLabel("Open").setStyle(ButtonStyle.Danger)),
    );
    return container;
}

// --- Badges tab ---

function badgesContainer(member: GuildMember, s: MemberAdminState, data: ProfileData, kit: RenderKit): ContainerBuilder {
    const { container, divider } = newContainer();
    const all = listedBadges(data);
    container.addTextDisplayComponents((td) =>
        td.setContent(`## \`${member.user.username}\`'s Badges\n${data.badges.length} of ${all.length} earned.`),
    );
    for (let slot = 0; slot < BADGES_PER_PAGE; slot++) {
        const badge = badgeOnPage(data, s.page, slot);
        if (!badge) break;
        const meta = getBadgeMeta(badge);
        const earned = data.badges.find((b) => b.badge === badge);
        divider();
        addRow(
            container,
            `**${meta.emoji} ${meta.display}**\n-# ${earned ? `Earned <t:${unix(earned.awarded_at)}:R>` : "Not earned"}`,
            kit.button(`badge:${slot}`, (b) =>
                b.setLabel(earned ? "Take" : "Give").setStyle(earned ? ButtonStyle.Danger : ButtonStyle.Success),
            ),
        );
    }
    return container;
}

// --- Sessions tab ---

/** Plain-text date range for a select option (a select can't render timestamps). */
function formatRange(start: Date, end: Date): string {
    const day = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    const time = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
    const sameDay = day(start) === day(end);
    return `${day(start)}, ${time(start)} - ${sameDay ? time(end) : `${day(end)}, ${time(end)}`}`;
}

function sessionRows(s: MemberAdminState, data: ProfileData, kit: RenderKit): ActionRowBuilder<ButtonBuilder>[] {
    const slice = sessionsOnPage(data, s.page);
    const pages = sessionPages(data);
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    if (slice.length === 0) return rows;
    rows.push(
        kit.row(
            kit.stringSelect("deleteSessions", (select) =>
                select
                    .setPlaceholder("Delete sessions…")
                    .setMinValues(1)
                    .setMaxValues(slice.length)
                    .addOptions(
                        slice.map((x) => ({
                            label: `#${x.id} · ${formatTime(x.duration_seconds)}`,
                            description: formatRange(x.started_at, x.ended_at),
                            value: String(x.id),
                        })),
                    ),
            ),
        ) as unknown as ActionRowBuilder<ButtonBuilder>,
    );
    if (pages > 1) rows.push(paginationRow(kit, s.page, pages));
    rows.push(buttonRow(kit.button("clearSessions", (b) => b.setLabel("Clear all").setStyle(ButtonStyle.Danger))));
    return rows;
}

// --- Biomes tab ---

function biomeSelectRow(data: ProfileData, kit: RenderKit): ActionRowBuilder<ButtonBuilder> {
    return kit.row(
        kit.stringSelect("pickBiome", (select) =>
            select.setPlaceholder("Pick a biome to edit").addOptions(
                editableBiomes(data).map((biome) => {
                    const count = biomeCount(data, biome);
                    const category = getBiomeMeta(biome)?.category;
                    return {
                        label: formatBiomeName(biome),
                        description: `${category ? BIOME_CATEGORY_LABELS[category] : "Other"} · ${count > 0 ? `${count} found` : "none yet"}`,
                        value: biome,
                    };
                }),
            ),
        ),
    ) as unknown as ActionRowBuilder<ButtonBuilder>;
}

function biomeEditor(data: ProfileData, biome: string, kit: RenderKit): Parts {
    const count = biomeCount(data, biome);
    const { container, divider } = newContainer(getBiomeColor(biome));
    const heading = `## ${formatBiomeName(biome)}\nFound \`${count}\` ${count === 1 ? "time" : "times"}`;
    const icon = getBiomeIconUrl(biome);
    if (icon) {
        container.addSectionComponents((section) =>
            section.addTextDisplayComponents((td) => td.setContent(heading)).setThumbnailAccessory((t) => t.setURL(icon)),
        );
    } else {
        container.addTextDisplayComponents((td) => td.setContent(heading));
    }
    divider();
    container.addTextDisplayComponents((td) => td.setContent("Changes here don't give Seeds, XP or badges."));
    return [
        container,
        buttonRow(
            kit.button("biomeDec", (b) => b.setLabel("−1").setDisabled(count === 0)),
            kit.button("biomeInc", (b) => b.setLabel("+1")),
            kit.button("biomeSet", (b) => b.setLabel("Set count")),
            kit.button("biomeClear", (b) =>
                b
                    .setLabel("Remove all")
                    .setStyle(ButtonStyle.Danger)
                    .setDisabled(count === 0),
            ),
            kit.button("back", (b) => b.setLabel("Back")),
        ),
    ];
}

// --- Macro channel ---

function channelScreen(s: MemberAdminState, kit: RenderKit): Parts {
    const { container } = newContainer();
    const channel = s.channel;
    container.addTextDisplayComponents((td) =>
        td.setContent(
            channel
                ? `## Macro channel\n<#${channel.channelId}>\n- Webhook: ${channel.webhookWorking ? "working" : "not working"}\n- Created <t:${unix(channel.createdAt)}:D>`
                : "## Macro channel\nNo channel.",
        ),
    );
    return [
        container,
        buttonRow(
            kit.button("recreate", (b) => b.setLabel(channel ? "Recreate channel" : "Create channel")),
            kit.button("existing", (b) => b.setLabel("Use an existing channel")),
        ),
        buttonRow(kit.button("back", (b) => b.setLabel("Back"))),
    ];
}

function existingScreen(kit: RenderKit): Parts {
    const { container } = newContainer();
    container.addTextDisplayComponents((td) =>
        td.setContent("**Use an existing channel**\nPick the channel their macro already posts to."),
    );
    container.addActionRowComponents(
        kit.row(
            kit.channelSelect("existingChannel", (c) =>
                c.setChannelTypes(ChannelType.GuildText).setMinValues(1).setMaxValues(1).setPlaceholder("Pick a channel"),
            ),
        ),
    );
    return [container, buttonRow(kit.button("cancelExisting", (b) => b.setLabel("Cancel")))];
}

// --- Danger zone ---

function dangerScreen(kit: RenderKit, hasChannel: boolean): Parts {
    const { container, divider } = newContainer(RED);
    container.addTextDisplayComponents((td) => td.setContent("## Danger zone"));
    addRow(
        container,
        "**Unlink member**\n-# Removes the channel, keeps the data.",
        kit.button("unlink", (b) => b.setLabel("Unlink").setStyle(ButtonStyle.Danger).setDisabled(!hasChannel)),
    );
    divider();
    addRow(
        container,
        "**Reset member**\n-# Wipes their progress, keeps the channel.",
        kit.button("reset", (b) => b.setLabel("Reset").setStyle(ButtonStyle.Danger)),
    );
    divider();
    addRow(
        container,
        "**Delete everything**\n-# Removes their whole profile.",
        kit.button("deleteAll", (b) => b.setLabel("Delete").setStyle(ButtonStyle.Danger)),
    );
    return [container, buttonRow(kit.button("back", (b) => b.setLabel("Back")))];
}

// --- No profile ---

function noProfileScreen(member: GuildMember, kit: RenderKit): Parts {
    const { container } = newContainer();
    container.addSectionComponents((section) =>
        section
            .addTextDisplayComponents((td) =>
                td.setContent(`## \`${member.user.username}\` has no profile\nThey haven't run \`/bh setup\` yet.`),
            )
            .setThumbnailAccessory((t) => t.setURL(member.displayAvatarURL())),
    );
    return [
        container,
        buttonRow(
            kit.button("setupDm", (b) => b.setLabel("Set up and DM them").setStyle(ButtonStyle.Primary)),
            kit.button("setupOnly", (b) => b.setLabel("Set up only")),
            kit.button("existing", (b) => b.setLabel("Use an existing channel")),
        ),
    ];
}

// --- Tabs ---

function tabScreen(member: GuildMember, s: MemberAdminState, data: ProfileData, kit: RenderKit): Parts {
    const parts: Parts = [];
    switch (s.tab) {
        case "biomes":
            parts.push(buildBiomesTabContainer(member, data), tabRow(s, kit), biomeSelectRow(data, kit));
            return parts;
        case "badges":
            parts.push(badgesContainer(member, s, data, kit), tabRow(s, kit));
            if (badgePages(data) > 1) parts.push(paginationRow(kit, s.page, badgePages(data)));
            return parts;
        case "sessions":
            parts.push(buildSessionsTabContainer(member, data, s.page, s.sessionTotal), tabRow(s, kit), ...sessionRows(s, data, kit));
            return parts;
        default:
            parts.push(buildProfileTabContainer(member, data), adminBox(s, data, kit), tabRow(s, kit));
            return parts;
    }
}

/** Builds the render for one member: the screen the state is on, as one message. */
export function renderMemberAdmin(member: GuildMember): (s: MemberAdminState, kit: RenderKit) => ViewRender {
    return (s, kit) => {
        const data = s.data;
        let components: Parts;
        if (s.screen === "existing") components = existingScreen(kit);
        else if (!data) components = noProfileScreen(member, kit);
        else if (s.screen === "channel") components = channelScreen(s, kit);
        else if (s.screen === "biome" && s.biome) components = biomeEditor(data, s.biome, kit);
        else if (s.screen === "danger") components = dangerScreen(kit, s.channel !== null);
        else components = tabScreen(member, s, data, kit);
        return { flags: MessageFlags.IsComponentsV2, components, allowedMentions: NO_PINGS };
    };
}
