import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    MessageFlags,
    SectionBuilder,
    SeparatorSpacingSize,
    TextDisplayBuilder,
    ThumbnailBuilder,
} from "discord.js";
import { defineView, type ViewPayload } from "@/define";
import {
    BIOME_CATEGORY_LABELS,
    BIOME_META,
    getBiomeColor,
    getBiomeIconUrl,
    spoofBiomeName,
} from "@/modules/biomehunt/constants/biomes.constants";
import { NO_PINGS, unix } from "@/utils/format";
import type { TestCase } from "../../registry";

/**
 * Candidate layouts for the forward card's finder/count lines. A card is as wide as its longest
 * line, so a long finder name on the counts line makes every card a different width. Each page
 * stacks three cards (short, medium and long finder names) so the width drift is visible at a
 * glance. Names are bold text standing in for the real `<@id>` mention pill (fake data can't
 * produce a real member's display name).
 */
const FAKE_JUMP_LINK = "https://discord.com/channels/0/0/0";
const FAKE_SERVER_LINK = "https://www.roblox.com/games/15532962292";
const FINDERS = [
    { name: "bnuy", personal: 44, server: 1772, lastMinutes: 10 },
    { name: "goodname", personal: 391, server: 1769, lastMinutes: 35 },
    { name: "Gloomy Tree | Fish Builder", personal: 588, server: 1771, lastMinutes: 20 },
];

interface CardData {
    biome: string;
    finder: string;
    personal: number;
    server: number;
    lastSeen: number;
    /** Set on rare biomes (they open a vote) - shown after "Found by", as secondary info. */
    voteId: string | null;
}

interface Layout {
    label: string;
    description: string;
    /** The lines next to the thumbnail. */
    heading(d: CardData, name: string, isRare: boolean): string[];
}

const FAKE_VOTE_ID = "abc12345";

const mention = (d: CardData) => `**@${d.finder}**`;
/** "Found by" is the main info; the vote id rides after it, smaller in importance. */
const foundBy = (d: CardData) => `-# Found by ${mention(d)}${d.voteId ? ` · Vote \`${d.voteId}\`` : ""}`;
const lastOne = (d: CardData) => `-# Last one <t:${d.lastSeen}:R>`;
const counter = (d: CardData) => `\`#${d.server}\``;
const heading = (name: string, isRare: boolean) => (isRare ? `## 🎉 ${name} found!` : `# ${name}`);
const headingCountRight = (d: CardData, name: string, isRare: boolean) =>
    isRare ? `## 🎉 ${name} found! ${counter(d)}` : `# ${name} ${counter(d)}`;
const headingCountLeft = (d: CardData, name: string, isRare: boolean) =>
    isRare ? `## ${counter(d)} 🎉 ${name} found!` : `# ${counter(d)} ${name}`;

/** Round 3: byline (Found by on top) x server count in the title, with the vote id after "Found by". */
const LAYOUTS: Record<string, Layout> = {
    "byline-count-right": {
        label: "★ Byline + count right",
        description: "Found by on top, # Blazing Sun `#1769`",
        heading: (d, name, isRare) => [foundBy(d), headingCountRight(d, name, isRare), `Personal find **#${d.personal}**`, lastOne(d)],
    },
    "byline-count-left": {
        label: "★ Byline + count left",
        description: "Found by on top, # `#1769` Blazing Sun",
        heading: (d, name, isRare) => [foundBy(d), headingCountLeft(d, name, isRare), `Personal find **#${d.personal}**`, lastOne(d)],
    },
    byline: {
        label: "Byline (both counts below)",
        description: "Found by on top, no count in the title",
        heading: (d, name, isRare) => [
            foundBy(d),
            heading(name, isRare),
            `Personal find **#${d.personal}** · Server find **#${d.server}**`,
            lastOne(d),
        ],
    },
    "count-right": {
        label: "Count right (Found by below)",
        description: "# Blazing Sun `#1769`, Found by under the title",
        heading: (d, name, isRare) => [headingCountRight(d, name, isRare), foundBy(d), `Personal find **#${d.personal}**`, lastOne(d)],
    },
    "count-left": {
        label: "Count left (Found by below)",
        description: "# `#1769` Blazing Sun, Found by under the title",
        heading: (d, name, isRare) => [headingCountLeft(d, name, isRare), foundBy(d), `Personal find **#${d.personal}**`, lastOne(d)],
    },
    "found-by": {
        label: "Found by (round 2 favourite)",
        description: "Reference: Found by under the title, both counts below",
        heading: (d, name, isRare) => [
            heading(name, isRare),
            foundBy(d),
            `Personal find **#${d.personal}** · Server find **#${d.server}**`,
            lastOne(d),
        ],
    },
};

function buildCard(layout: Layout, d: CardData): ContainerBuilder {
    const isRare = BIOME_META[d.biome].category === "rare";
    const name = `[${spoofBiomeName(d.biome)}](${FAKE_SERVER_LINK})`;
    const c = new ContainerBuilder().setAccentColor(getBiomeColor(d.biome));
    c.addSectionComponents(
        new SectionBuilder()
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(layout.heading(d, name, isRare).join("\n")))
            .setThumbnailAccessory(new ThumbnailBuilder({ media: { url: getBiomeIconUrl(d.biome) ?? "https://i.imgur.com/BMKWWJ3.png" } })),
    );
    if (d.voteId) {
        c.addSeparatorComponents((s) => s.setSpacing(SeparatorSpacingSize.Large));
        c.addTextDisplayComponents((td) =>
            td.setContent(`**Is this biome real?** · 2 votes · voting closes <t:${unix(new Date(Date.now() + 52_000))}:R>`),
        );
        c.addActionRowComponents(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId(`biomehunt:vote:${d.voteId}:real`)
                    .setLabel("Real")
                    .setEmoji("✅")
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId(`biomehunt:vote:${d.voteId}:fake`)
                    .setLabel("Fake")
                    .setEmoji("❌")
                    .setStyle(ButtonStyle.Secondary),
            ),
        );
    }
    c.addSeparatorComponents((s) => s.setSpacing(SeparatorSpacingSize.Large));
    c.addActionRowComponents(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(FAKE_JUMP_LINK).setLabel("Jump to Message"),
            new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(FAKE_SERVER_LINK).setLabel("Join Private Server").setEmoji("🔗"),
        ),
    );
    return c;
}

interface PreviewState {
    layout: string;
    biome: string;
}

export default {
    description: "Forward card finder/count layouts, three finder-name lengths stacked to compare card widths.",
    view() {
        return defineView<PreviewState, void, void>({
            name: "tests.forward-layouts",
            initial: () => ({ layout: "byline-count-right", biome: "GLITCHED" }),
            render: (state, kit): ViewPayload => {
                const layout = LAYOUTS[state.layout];
                const now = Date.now();
                // Rare cards carry a vote block; three of them would pass Discord's 40-component limit, so show the shortest and longest name only.
                const isRare = BIOME_META[state.biome].category === "rare";
                const finders = isRare ? [FINDERS[0], FINDERS[FINDERS.length - 1]] : FINDERS;
                const cards = finders.map((f, i) =>
                    buildCard(layout, {
                        biome: state.biome,
                        finder: f.name,
                        personal: f.personal,
                        server: f.server,
                        lastSeen: unix(new Date(now - f.lastMinutes * 60_000)),
                        // One id per card: Discord rejects a message whose buttons repeat a custom_id.
                        voteId: isRare ? `${FAKE_VOTE_ID.slice(0, -1)}${i}` : null,
                    }),
                );
                const layoutSelect = kit.stringSelect("layout", (s) =>
                    s.setPlaceholder("Layout").addOptions(
                        Object.entries(LAYOUTS).map(([value, l]) => ({
                            label: l.label,
                            value,
                            description: l.description,
                            default: value === state.layout,
                        })),
                    ),
                );
                const biomeSelect = kit.stringSelect("biome", (s) =>
                    s.setPlaceholder("Biome").addOptions(
                        Object.entries(BIOME_META).map(([value, meta]) => ({
                            label: meta.label,
                            value,
                            description: BIOME_CATEGORY_LABELS[meta.category],
                            default: value === state.biome,
                        })),
                    ),
                );
                return {
                    flags: MessageFlags.IsComponentsV2,
                    components: [
                        new TextDisplayBuilder().setContent(`-# Layout: **${layout.label}**`),
                        ...cards,
                        kit.row(layoutSelect),
                        kit.row(biomeSelect),
                    ],
                    allowedMentions: NO_PINGS,
                };
            },
            on: {
                layout: (c) => {
                    c.state.layout = c.values[0];
                },
                biome: (c) => {
                    c.state.biome = c.values[0];
                },
            },
        });
    },
} satisfies TestCase;
