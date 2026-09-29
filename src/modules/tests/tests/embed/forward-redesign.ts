import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    MediaGalleryBuilder,
    MessageFlags,
    SectionBuilder,
    SeparatorSpacingSize,
    TextDisplayBuilder,
    ThumbnailBuilder,
} from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { BIOME_CATEGORY_LABELS, BIOME_META, getBiomeColor, getBiomeIconUrl } from "@/modules/biomehunt/constants/biomes.constants";
import { REWARD_BY_CATEGORY } from "@/modules/biomehunt/constants/levels.constants";
import { forwardInfoCustomId } from "@/modules/biomehunt/views/forward-post.view";
import { formatTime, NO_PINGS, unix } from "@/utils/format";
import type { TestCase, TestPayload } from "../../registry";

/**
 * Six candidate redesigns of the biome forward, one per page - fake data only. Every extra field
 * below is something the bot can actually get at forward time:
 * - finder: `bh_users.discord_user_id` (already loaded to resolve the event's user)
 * - found at: the detection time; category/rewards: `BIOME_META` / `REWARD_BY_CATEGORY`
 * - personal count: `getBiomeCountForUser` (already queried today)
 * - server count / last seen in server: one COUNT / one MAX(started_at) over `bh_activity_events` (new queries)
 * - level: derived from `bh_users.xp`; macro: `ParsedEvent.macroType`
 * - session length: `getLatestSessionForUser`
 */
const BIOME = "GLITCHED";
const FAKE_ROLE_ID = "1";
const FAKE_VOTE_ID = "preview0";
const FAKE_JUMP_LINK = "https://discord.com/channels/0/0/0";
const FAKE_SERVER_LINK = "https://www.roblox.com/games/15532962292";

interface FakeFind {
    finderId: string;
    foundAt: Date;
    personalCount: number;
    serverCount: number;
    lastSeenInServerAt: Date;
    level: number;
    macro: string;
    sessionSeconds: number;
}

function fakeFind(client: BotClient): FakeFind {
    const now = Date.now();
    return {
        finderId: client.user?.id ?? "0",
        foundAt: new Date(now - 8_000),
        personalCount: 3,
        serverCount: 41,
        lastSeenInServerAt: new Date(now - 2 * 86_400_000 - 5 * 3_600_000),
        level: 12,
        macro: "Maxstellar",
        sessionSeconds: 3 * 3600 + 12 * 60,
    };
}

const meta = BIOME_META[BIOME];
const name = meta.label;
const category = BIOME_CATEGORY_LABELS[meta.category];
const reward = REWARD_BY_CATEGORY[meta.category];

function ordinal(n: number): string {
    const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : (({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th");
    return `${n}${suffix}`;
}

function linkRow(): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(FAKE_JUMP_LINK).setLabel("Jump to Message"),
        new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(FAKE_SERVER_LINK).setLabel("Join Private Server").setEmoji("🔗"),
        new ButtonBuilder()
            .setCustomId(forwardInfoCustomId({ delayed: true }))
            .setLabel("?")
            .setStyle(ButtonStyle.Secondary),
    );
}

function voteRow(): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`biomehunt:vote:${FAKE_VOTE_ID}:real`)
            .setLabel("Real")
            .setEmoji("✅")
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`biomehunt:vote:${FAKE_VOTE_ID}:fake`)
            .setLabel("Fake")
            .setEmoji("❌")
            .setStyle(ButtonStyle.Secondary),
    );
}

function closesAt(): number {
    return unix(new Date(Date.now() + 52_000));
}

function section(content: string): SectionBuilder {
    return new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(content))
        .setThumbnailAccessory(new ThumbnailBuilder({ media: { url: getBiomeIconUrl(BIOME) ?? "" } }));
}

function page(label: string, container: ContainerBuilder): TestPayload {
    return {
        flags: MessageFlags.IsComponentsV2,
        components: [new TextDisplayBuilder().setContent(`-# Design ${label}`), container],
        allowedMentions: NO_PINGS,
    } as TestPayload;
}

/** 1 - today's layout, tightened: finder + time in the heading, one muted stats line, vote + badges as now. */
function refinedClassic(f: FakeFind): TestPayload {
    const c = new ContainerBuilder().setAccentColor(getBiomeColor(BIOME));
    c.addTextDisplayComponents((td) => td.setContent(`-# Vote \`${FAKE_VOTE_ID}\` · 2 votes · closes <t:${closesAt()}:R>`));
    c.addSectionComponents(
        section(
            [
                `# [${name}](${FAKE_SERVER_LINK})`,
                `<@&${FAKE_ROLE_ID}>`,
                `Found by <@${f.finderId}> <t:${unix(f.foundAt)}:R>`,
                `-# their ${ordinal(f.personalCount)} · ${ordinal(f.serverCount)} in this server · last one <t:${unix(f.lastSeenInServerAt)}:R>`,
            ].join("\n"),
        ),
    );
    c.addSeparatorComponents((s) => s.setSpacing(SeparatorSpacingSize.Large));
    c.addTextDisplayComponents((td) => td.setContent("**Is this biome real?**\n-# Administrators can immediately decide this vote"));
    c.addActionRowComponents(voteRow());
    c.addSeparatorComponents((s) => s.setSpacing(SeparatorSpacingSize.Large));
    c.addTextDisplayComponents((td) => td.setContent("⏳"));
    c.addActionRowComponents(linkRow());
    return page("1 · Refined classic", c);
}

/** 2 - hero: the biome art full-width on top, then a short caption - the most eye-catching for rare finds. */
function hero(f: FakeFind): TestPayload {
    const c = new ContainerBuilder().setAccentColor(getBiomeColor(BIOME));
    c.addMediaGalleryComponents(new MediaGalleryBuilder().addItems((i) => i.setURL(getBiomeIconUrl(BIOME) ?? "")));
    c.addTextDisplayComponents((td) =>
        td.setContent(
            [
                `# ${name}  \`${category.toUpperCase()}\``,
                `<@&${FAKE_ROLE_ID}> · found by <@${f.finderId}> <t:${unix(f.foundAt)}:R>`,
                `-# their ${ordinal(f.personalCount)} ${name} · ${ordinal(f.serverCount)} in this server`,
            ].join("\n"),
        ),
    );
    c.addSeparatorComponents((s) => s.setSpacing(SeparatorSpacingSize.Large));
    c.addTextDisplayComponents((td) => td.setContent(`**Is this biome real?** · 2 votes · closes <t:${closesAt()}:R>`));
    c.addActionRowComponents(voteRow());
    c.addSeparatorComponents((s) => s.setSpacing(SeparatorSpacingSize.Large));
    c.addTextDisplayComponents((td) => td.setContent("⏳"));
    c.addActionRowComponents(linkRow());
    return page("2 · Hero image", c);
}

/** 3 - profile-style: a title, then labelled bullet fields - most information, easiest to scan. */
function fields(f: FakeFind): TestPayload {
    const c = new ContainerBuilder().setAccentColor(getBiomeColor(BIOME));
    c.addSectionComponents(section(`## [${name}](${FAKE_SERVER_LINK}) found!\n<@&${FAKE_ROLE_ID}>`));
    c.addSeparatorComponents((s) => s.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    c.addTextDisplayComponents((td) =>
        td.setContent(
            [
                `- **Finder:** <@${f.finderId}> (Lv. ${f.level})`,
                `- **Found:** <t:${unix(f.foundAt)}:T> (<t:${unix(f.foundAt)}:R>)`,
                `- **Rarity:** ${category}`,
                `- **Count:** their ${ordinal(f.personalCount)} · ${ordinal(f.serverCount)} in this server`,
                `- **Last one here:** <t:${unix(f.lastSeenInServerAt)}:R>`,
                `- **Macro:** ${f.macro} · running for ${formatTime(f.sessionSeconds)}`,
            ].join("\n"),
        ),
    );
    c.addSeparatorComponents((s) => s.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    c.addTextDisplayComponents((td) =>
        td.setContent(`**Is this biome real?**\n-# \`${FAKE_VOTE_ID}\` · 2 votes · closes <t:${closesAt()}:R>`),
    );
    c.addActionRowComponents(voteRow());
    c.addSeparatorComponents((s) => s.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    c.addTextDisplayComponents((td) => td.setContent("⏳"));
    c.addActionRowComponents(linkRow());
    return page("3 · Profile-style fields", c);
}

/** 4 - compact: one section, no dividers - for busy channels full of weather/biome forwards. */
function compact(f: FakeFind): TestPayload {
    const c = new ContainerBuilder().setAccentColor(getBiomeColor(BIOME));
    c.addSectionComponents(
        section(
            [
                `### [${name}](${FAKE_SERVER_LINK}) · <t:${unix(f.foundAt)}:R>`,
                `<@${f.finderId}> · their ${ordinal(f.personalCount)} · <@&${FAKE_ROLE_ID}>`,
                `-# ⏳ · vote \`${FAKE_VOTE_ID}\` closes <t:${closesAt()}:R>`,
            ].join("\n"),
        ),
    );
    c.addActionRowComponents(voteRow());
    c.addActionRowComponents(linkRow());
    return page("4 · Compact", c);
}

/** 5 - announcement: a celebratory headline about the finder, with what they earn - most "social". */
function announcement(f: FakeFind): TestPayload {
    const c = new ContainerBuilder().setAccentColor(getBiomeColor(BIOME));
    c.addTextDisplayComponents((td) => td.setContent(`<@&${FAKE_ROLE_ID}>`));
    c.addSectionComponents(
        section(
            [
                `## 🎉 <@${f.finderId}> found a [${name}](${FAKE_SERVER_LINK})!`,
                `That's their **${ordinal(f.personalCount)}** ${name}, and the **${ordinal(f.serverCount)}** in this server.`,
                `-# ${category} biome · found <t:${unix(f.foundAt)}:R> · last one here <t:${unix(f.lastSeenInServerAt)}:R>`,
            ].join("\n"),
        ),
    );
    c.addSeparatorComponents((s) => s.setSpacing(SeparatorSpacingSize.Large));
    c.addTextDisplayComponents((td) =>
        td.setContent(
            `**Is this biome real?** · closes <t:${closesAt()}:R>\n-# If confirmed: +${reward.seeds} 🌱 Seeds · +${reward.xp} XP for <@${f.finderId}>`,
        ),
    );
    c.addActionRowComponents(voteRow());
    c.addSeparatorComponents((s) => s.setSpacing(SeparatorSpacingSize.Large));
    c.addTextDisplayComponents((td) => td.setContent("⏳"));
    c.addActionRowComponents(linkRow());
    return page("5 · Announcement", c);
}

/** 6 - stat chips: the heading stays clean, all numbers go into a row of inline-code "chips". */
function chips(f: FakeFind): TestPayload {
    const c = new ContainerBuilder().setAccentColor(getBiomeColor(BIOME));
    c.addSectionComponents(
        section(
            [`# [${name}](${FAKE_SERVER_LINK})`, `<@&${FAKE_ROLE_ID}>`, `🙋 <@${f.finderId}> · 🕒 <t:${unix(f.foundAt)}:R>`].join("\n"),
        ),
    );
    c.addTextDisplayComponents((td) =>
        td.setContent(
            [
                `\`${category}\``,
                `\`#${f.personalCount} theirs\``,
                `\`#${f.serverCount} server\``,
                `\`Lv. ${f.level}\``,
                `\`${f.macro}\``,
                `\`${formatTime(f.sessionSeconds)} session\``,
            ].join(" "),
        ),
    );
    c.addSeparatorComponents((s) => s.setSpacing(SeparatorSpacingSize.Large));
    c.addTextDisplayComponents((td) => td.setContent(`**Is this biome real?**\n-# 2 votes · closes <t:${closesAt()}:R>`));
    c.addActionRowComponents(voteRow());
    c.addSeparatorComponents((s) => s.setSpacing(SeparatorSpacingSize.Large));
    c.addTextDisplayComponents((td) => td.setContent("⏳"));
    c.addActionRowComponents(linkRow());
    return page("6 · Stat chips", c);
}

export default {
    description: "Six candidate redesigns of BiomeHunt's biome forward (rare + delayed, open vote), one per page - fake data.",
    pages(client: BotClient): TestPayload[] {
        const f = fakeFind(client);
        return [refinedClassic(f), hero(f), fields(f), compact(f), announcement(f), chips(f)];
    },
} satisfies TestCase;
