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
import type { BotClient } from "@/core/bot-client";
import { defineView, type ViewPayload } from "@/define";
import {
    BIOME_CATEGORY_LABELS,
    BIOME_META,
    formatBiomeName,
    getBiomeColor,
    getBiomeIconUrl,
} from "@/modules/biomehunt/constants/biomes.constants";
import { VoteStatus } from "@/modules/biomehunt/types";
import { type ForwardBadges, forwardInfoCustomId, type VoteRenderInfo } from "@/modules/biomehunt/views/forward-post.view";
import { NO_PINGS, unix } from "@/utils/format";
import type { TestCase } from "../../registry";

/**
 * The "Announcement" forward redesign (design 5 of the first round), previewed interactively: pick
 * any biome and any scenario (vote states, delayed, simulated, first find, no server link) from the
 * two selects. Fake data only. Rare biomes get the big "🎉 @finder found a X!" headline; everything
 * else keeps a simple biome-name title. What the new lines need at forward time:
 * - finder: `bh_users.discord_user_id`; personal count: `getBiomeCountForUser` (both already loaded)
 * - server count / last one in this server: one COUNT / one MAX(started_at) over `bh_activity_events` (new queries)
 * No user is ever pinged - not the finder, not the deciding admin: the real send must use
 * `allowedMentions: { roles: [roleId] }` (only the forward's role pings), and vote-close edits
 * `allowedMentions: { parse: [] }`. This preview pings nobody at all.
 */
const FAKE_ROLE_ID = "1";
const FAKE_VOTE_ID = "preview0";
const FAKE_JUMP_LINK = "https://discord.com/channels/0/0/0";
const FAKE_SERVER_LINK = "https://www.roblox.com/games/15532962292";

interface Scenario {
    label: string;
    description: string;
    vote?: Omit<VoteRenderInfo, "voteId" | "closesAt" | "decidedByUserId">;
    badges?: ForwardBadges;
    firstFind?: boolean;
    noServerLink?: boolean;
}

const SCENARIOS: Record<string, Scenario> = {
    plain: { label: "Regular find", description: "Non-rare biome, no vote - the most common forward" },
    "vote-open": {
        label: "Vote - open",
        description: "Rare biome right after it's found",
        vote: { status: VoteStatus.OPEN, voteCount: 2 },
    },
    "vote-real": {
        label: "Vote - ruled real",
        description: "Community voted real",
        vote: { status: VoteStatus.COMMUNITY_REAL, voteCount: 5, tally: { real: 4, fake: 1 } },
    },
    "vote-fake": {
        label: "Vote - ruled fake",
        description: "Community voted fake",
        vote: { status: VoteStatus.COMMUNITY_FAKE, voteCount: 5, tally: { real: 1, fake: 4 } },
    },
    "vote-tie": {
        label: "Vote - tie",
        description: "Same number of real/fake votes",
        vote: { status: VoteStatus.TIE, voteCount: 4, tally: { real: 2, fake: 2 } },
    },
    "vote-none": {
        label: "Vote - no votes",
        description: "Nobody voted before it closed",
        vote: { status: VoteStatus.NO_VOTES, voteCount: 0 },
    },
    "vote-admin-real": {
        label: "Vote - admin confirmed",
        description: "An administrator ruled it real",
        vote: { status: VoteStatus.ADMIN_CONFIRMED, voteCount: 1, tally: { real: 1, fake: 0 } },
    },
    "vote-admin-fake": {
        label: "Vote - admin denied",
        description: "An administrator ruled it fake",
        vote: { status: VoteStatus.ADMIN_DENIED, voteCount: 1, tally: { real: 0, fake: 1 } },
    },
    delayed: { label: "Delayed forward", description: "Sent to the delayed channel (⏳ + ?)", badges: { delayed: true } },
    simulated: { label: "Simulated (dry run)", description: "/bh-owner simulate-biome - banner + 🧪", badges: { simulated: true } },
    first: { label: "First find ever", description: "Their first, and the server's first", firstFind: true },
    "no-link": { label: "No private server link", description: "Macro didn't send a server link", noServerLink: true },
};

function ordinal(n: number): string {
    const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : (({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th");
    return `${n}${suffix}`;
}

function linkRow(serverLink: string | null, badges: ForwardBadges | undefined): ActionRowBuilder<ButtonBuilder> {
    const buttons = [new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(FAKE_JUMP_LINK).setLabel("Jump to Message")];
    if (serverLink)
        buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(serverLink).setLabel("Join Private Server").setEmoji("🔗"));
    if (badges) buttons.push(new ButtonBuilder().setCustomId(forwardInfoCustomId(badges)).setLabel("?").setStyle(ButtonStyle.Secondary));
    return new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);
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

/** Top line of a voted forward: the id, plus the ballot count while it's still open. */
function voteIdLine(vote: VoteRenderInfo): string {
    const id = `-# Vote ID: \`${vote.voteId}\``;
    if (vote.status !== VoteStatus.OPEN) return id;
    return `${id} • ${vote.voteCount} vote${vote.voteCount === 1 ? "" : "s"}`;
}

/** The vote block's text - "Is this biome real?" while open, then "Marked as real/fake by ..." once decided. */
function voteStatusLine(vote: VoteRenderInfo): string {
    const tally = vote.tally ? ` \`✅ ${vote.tally.real}\` \`❌ ${vote.tally.fake}\`` : "";
    switch (vote.status) {
        case VoteStatus.OPEN:
            return `**Is this biome real?** · voting closes <t:${unix(vote.closesAt)}:R>\n-# Administrators can immediately decide this vote`;
        case VoteStatus.NO_VOTES:
            return "*Vote expired with no votes*";
        case VoteStatus.TIE:
            return `⚖️ Tied vote${tally}`;
        case VoteStatus.COMMUNITY_REAL:
            return `✅ Marked as real by community voting${tally}`;
        case VoteStatus.COMMUNITY_FAKE:
            return `❌ Marked as fake by community voting${tally}`;
        case VoteStatus.ADMIN_CONFIRMED:
            return `✅ Marked as real by <@${vote.decidedByUserId}>`;
        case VoteStatus.ADMIN_DENIED:
            return `❌ Marked as fake by <@${vote.decidedByUserId}>`;
    }
}

/** The Announcement card itself - what `buildForwardContainer` would become. */
function buildAnnouncement(biome: string, scenario: Scenario, finderId: string): ContainerBuilder {
    const now = Date.now();
    const name = formatBiomeName(biome);
    const isRare = BIOME_META[biome].category === "rare";
    const serverLink = scenario.noServerLink ? null : FAKE_SERVER_LINK;
    const title = serverLink ? `[${name}](${serverLink})` : name;
    const lastOneHere = unix(new Date(now - 2 * 86_400_000 - 5 * 3_600_000));
    const vote: VoteRenderInfo | undefined = scenario.vote && {
        ...scenario.vote,
        voteId: FAKE_VOTE_ID,
        closesAt: new Date(now + 52_000),
        decidedByUserId: finderId,
    };

    const c = new ContainerBuilder().setAccentColor(getBiomeColor(biome));
    if (scenario.badges?.simulated) {
        c.addTextDisplayComponents((td) => td.setContent("### 🧪 SIMULATED FORWARD - TESTING ONLY"));
        c.addSeparatorComponents((s) => s.setDivider(true).setSpacing(SeparatorSpacingSize.Large));
    }
    if (vote) c.addTextDisplayComponents((td) => td.setContent(voteIdLine(vote)));
    c.addTextDisplayComponents((td) => td.setContent(`<@&${FAKE_ROLE_ID}>`));

    // Rare: the big "🎉 @finder found a X!" headline. Everything else: just the biome name, finder in the count line.
    const counts = scenario.firstFind
        ? isRare
            ? `That's their **first** ${name} ever, and the **first** one in this server!`
            : `<@${finderId}>'s **first** ${name} ever, and the **first** one in this server!`
        : isRare
          ? `That's their **3rd** ${name}, and the **${ordinal(41)}** in this server.`
          : `<@${finderId}>'s **3rd** ${name}, and the **${ordinal(41)}** in this server.`;
    const lines = [
        isRare ? `## 🎉 <@${finderId}> found ${/^[AEIOU]/i.test(name) ? "an" : "a"} ${title}!` : `# ${title}`,
        counts,
        ...(scenario.firstFind ? [] : [`-# Last one here <t:${lastOneHere}:R>`]),
    ].join("\n");
    const iconUrl = getBiomeIconUrl(biome);
    if (iconUrl) {
        c.addSectionComponents(
            new SectionBuilder()
                .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines))
                .setThumbnailAccessory(new ThumbnailBuilder({ media: { url: iconUrl } })),
        );
    } else {
        c.addTextDisplayComponents((td) => td.setContent(lines));
    }

    if (vote) {
        c.addSeparatorComponents((s) => s.setSpacing(SeparatorSpacingSize.Large));
        c.addTextDisplayComponents((td) => td.setContent(voteStatusLine(vote)));
        if (vote.status === VoteStatus.OPEN) c.addActionRowComponents(voteRow());
    }

    c.addSeparatorComponents((s) => s.setSpacing(SeparatorSpacingSize.Large));
    const emojis = [scenario.badges?.delayed ? "⏳" : null, scenario.badges?.simulated ? "🧪" : null].filter(Boolean).join(" ");
    if (emojis) c.addTextDisplayComponents((td) => td.setContent(emojis));
    c.addActionRowComponents(linkRow(serverLink, scenario.badges));
    return c;
}

interface PreviewState {
    biome: string;
    scenario: string;
}

export default {
    description:
        'The "Announcement" biome forward redesign - pick any biome and scenario (vote states, delayed, simulated...) from selects.',
    view(client: BotClient) {
        const finderId = client.user?.id ?? "0";
        return defineView<PreviewState, void, void>({
            name: "tests.forward-redesign",
            initial: () => ({ biome: "GLITCHED", scenario: "vote-open" }),
            render: (state, kit): ViewPayload => {
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
                const scenarioSelect = kit.stringSelect("scenario", (s) =>
                    s.setPlaceholder("Scenario").addOptions(
                        Object.entries(SCENARIOS).map(([value, sc]) => ({
                            label: sc.label,
                            value,
                            description: sc.description,
                            default: value === state.scenario,
                        })),
                    ),
                );
                return {
                    flags: MessageFlags.IsComponentsV2,
                    components: [
                        buildAnnouncement(state.biome, SCENARIOS[state.scenario], finderId),
                        kit.row(biomeSelect),
                        kit.row(scenarioSelect),
                    ],
                    allowedMentions: NO_PINGS,
                };
            },
            on: {
                biome: (c) => {
                    c.state.biome = c.values[0];
                },
                scenario: (c) => {
                    c.state.scenario = c.values[0];
                },
            },
        });
    },
} satisfies TestCase;
