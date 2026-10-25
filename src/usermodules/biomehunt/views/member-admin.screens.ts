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
import {
    buildMemberQuality,
    type FindTally,
    type MemberQuality,
    type QualityEvent,
    type QualityLevel,
} from "../services/member-quality.service";
import { type MemberLogRow, VoteStatus } from "../types";
import type { MemberAdminState } from "./member-admin.view";
import { formatHours } from "./settings.screens";
import {
    buildBiomesTabContainer,
    buildProfileTabContainer,
    buildSessionsTabContainer,
    inspectSessionRow,
    type ProfileData,
    sessionPages,
    sessionsOnPage,
} from "./stats-builders";

export const BADGES_PER_PAGE = 5;
/** Discord shows at most this many options in a select. */
const MAX_SELECT_OPTIONS = 25;

export const MEMBER_TABS = [
    { key: "profile", label: "Profile" },
    { key: "biomes", label: "Biomes" },
    { key: "badges", label: "Badges" },
    { key: "sessions", label: "Sessions" },
    { key: "quality", label: "Quality" },
] as const;

export type MemberTab = (typeof MEMBER_TABS)[number]["key"];

/** History rows per page on the Quality tab. */
export const QUALITY_PER_PAGE = 5;

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
    rows.push(inspectSessionRow(kit, slice, data.rareFinds));
    if (pages > 1) rows.push(paginationRow(kit, s.page, pages));
    rows.push(buttonRow(kit.button("clearSessions", (b) => b.setLabel("Clear all").setStyle(ButtonStyle.Danger))));
    return rows;
}

// --- Quality tab ---

const LEVEL_STYLE: Record<QualityLevel, { color: number; label: string }> = {
    none: { color: 0x80848e, label: "⚪ **No record yet**" },
    trusted: { color: 0x3ba55d, label: "🟢 **Trusted**" },
    watch: { color: 0xf0b232, label: "🟡 **Keep an eye on**" },
    untrusted: { color: RED, label: "🔴 **Not trusted**" },
};

export const qualityPages = (q: MemberQuality | null) => Math.max(Math.ceil((q?.history.length ?? 0) / QUALITY_PER_PAGE), 1);

export function qualityEventOnPage(q: MemberQuality | null, page: number, slot: number): QualityEvent | undefined {
    return q?.history[page * QUALITY_PER_PAGE + slot];
}

/** What a History row's Review opens - a local find's vote, or a Network find of this server. `null` = nothing to review. */
export function reviewIdOf(event: QualityEvent, guildId: string): string | null {
    if (event.type === "local") return event.find.vote?.id ?? null;
    if (event.type === "network") return event.post.origin_guild_id === guildId ? event.post.id : null;
    return null;
}

const by = (id: string | null) => (id ? ` by <@${id}>` : "");

/** A signed amount: `+500 Seeds` / `-20 XP`. */
const signed = (n: number, unit: string) => `${n > 0 ? "+" : ""}${num(n)} ${unit}`;

/** One logged admin action as its History line. */
function logLine(row: MemberLogRow): string {
    switch (row.kind) {
        case "seeds_xp": {
            const parts = [row.detail.seeds ? signed(row.detail.seeds, "Seeds") : null, row.detail.xp ? signed(row.detail.xp, "XP") : null];
            return `🌱 **${parts.filter(Boolean).join(", ")}**${by(row.by_discord_id)}`;
        }
        case "badge_given":
            return `🏅 **${getBadgeMeta(row.detail.badge).display}** badge given${by(row.by_discord_id)}`;
        case "badge_taken":
            return `🏅 **${getBadgeMeta(row.detail.badge).display}** badge taken away${by(row.by_discord_id)}`;
        case "finds_changed": {
            const { biome, from, to } = row.detail;
            const n = Math.abs(to - from);
            return `${to < from ? "✂️" : "➕"} **${plural(n, `${formatBiomeName(biome)} find`)}** ${to < from ? "removed" : "added"}${by(row.by_discord_id)}`;
        }
        case "sessions_deleted":
            return `🗑️ **${plural(row.detail.count, "session")}** deleted${by(row.by_discord_id)}`;
        case "reset":
            return `♻️ **Progress reset**${by(row.by_discord_id)}`;
        case "auto_delete_paused":
            return `⏸️ **Auto-delete** paused${by(row.by_discord_id)}`;
        case "auto_delete_resumed":
            return `▶️ **Auto-delete** resumed${by(row.by_discord_id)}`;
        case "channel_set_up":
            return `📺 **Macro channel** set up${by(row.by_discord_id)}`;
        case "unlinked":
            return `🔗 **Unlinked**${by(row.by_discord_id)}`;
        case "deleted_everything":
            return `💥 **Profile deleted**${by(row.by_discord_id)}`;
    }
}

/** A History row: its line, then the date (and where, for a find) as subtext. */
export function qualityEventText(event: QualityEvent, guildId: string): string {
    const date = `<t:${unix(event.at)}:D>`;
    if (event.type === "local") {
        const vote = event.find.vote;
        const biome = `**${formatBiomeName(event.find.biome)}**`;
        const line =
            vote?.status === VoteStatus.ADMIN_DENIED
                ? `❌ ${biome} marked fake${by(vote.decidedBy)}`
                : `❌ ${biome} voted fake \`✅ ${vote?.real ?? 0}\` \`❌ ${vote?.fake ?? 0}\``;
        return `${line}\n-# ${date} · this server`;
    }
    if (event.type === "network") {
        const p = event.post;
        const line = p.vote_decided_by
            ? `❌ **${formatBiomeName(p.biome)}** marked fake${by(p.vote_decided_by)}`
            : `❌ **${formatBiomeName(p.biome)}** voted fake by the Network`;
        return `${line}\n-# ${date} · Network${p.origin_guild_id === guildId ? "" : ` · from ${p.origin_name}`}`;
    }
    return `${logLine(event.log)}\n-# ${date}`;
}

/** `This server \`✅ 21 real\` \`❌ 1 fake\` \`⚖️ 1 tied\`` - tied and voting only when there are some. */
function tallyLine(label: string, t: FindTally): string {
    const chips = [
        `\`✅ ${t.real} real\``,
        `\`❌ ${t.fake} fake\``,
        t.tied ? `\`⚖️ ${t.tied} tied\`` : null,
        t.voting ? `\`⏳ ${t.voting} voting\`` : null,
    ];
    return `${label} ${chips.filter(Boolean).join(" ")}`;
}

const tallyTotal = (t: FindTally) => t.real + t.fake + t.tied + t.voting;

function qualityContainer(member: GuildMember, s: MemberAdminState, q: MemberQuality, kit: RenderKit): ContainerBuilder {
    const style = LEVEL_STYLE[q.level];
    const { container, divider } = newContainer(style.color);
    const decided = q.local.real + q.local.fake + q.network.real + q.network.fake;
    const fakes = q.local.fake + q.network.fake;
    const summary =
        q.level === "none"
            ? `${style.label} · ${plural(tallyTotal(q.local) + tallyTotal(q.network), "rare find")}`
            : `${style.label} · ${plural(fakes, "fake")} in ${plural(decided, "rare find")}`;
    container.addSectionComponents((section) =>
        section
            .addTextDisplayComponents((td) => td.setContent(`## \`${member.user.username}\`'s Quality\n${summary}`))
            .setThumbnailAccessory((t) => t.setURL(member.displayAvatarURL())),
    );
    divider();
    const finds = [
        tallyTotal(q.local) > 0 ? tallyLine("This server", q.local) : null,
        tallyTotal(q.network) > 0 ? tallyLine("Network", q.network) : null,
    ].filter(Boolean);
    container.addTextDisplayComponents((td) => td.setContent(`**Rare finds**\n${finds.length ? finds.join("\n") : "None yet."}`));
    const a = q.actions;
    const actions = [
        a.sessionsDeleted ? `🗑️ **${num(a.sessionsDeleted)}** ${a.sessionsDeleted === 1 ? "session" : "sessions"} deleted` : null,
        a.badgesTaken ? `🏅 **${num(a.badgesTaken)}** ${a.badgesTaken === 1 ? "badge" : "badges"} taken` : null,
        a.findsRemoved ? `✂️ **${num(a.findsRemoved)}** ${a.findsRemoved === 1 ? "find" : "finds"} removed` : null,
    ].filter(Boolean);
    if (actions.length > 0) {
        divider();
        container.addTextDisplayComponents((td) => td.setContent(`**Admin actions**\n${actions.join(" · ")}`));
    }
    divider();
    if (q.history.length === 0) {
        container.addTextDisplayComponents((td) => td.setContent("**History**\nNothing yet."));
        return container;
    }
    container.addTextDisplayComponents((td) => td.setContent("**History**"));
    const guildId = member.guild.id;
    for (let slot = 0; slot < QUALITY_PER_PAGE; slot++) {
        const event = qualityEventOnPage(q, s.page, slot);
        if (!event) break;
        const text = qualityEventText(event, guildId);
        if (reviewIdOf(event, guildId))
            addRow(
                container,
                text,
                kit.button(`review:${slot}`, (b) => b.setLabel("Review")),
            );
        else container.addTextDisplayComponents((td) => td.setContent(text));
    }
    return container;
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
        case "quality": {
            const quality = s.quality ?? buildMemberQuality([], [], []);
            parts.push(qualityContainer(member, s, quality, kit), tabRow(s, kit));
            if (qualityPages(quality) > 1) parts.push(paginationRow(kit, s.page, qualityPages(quality)));
            return parts;
        }
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
