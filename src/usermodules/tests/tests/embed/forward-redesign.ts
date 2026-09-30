import { MessageFlags } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { defineView, type ViewPayload } from "@/define";
import { BIOME_CATEGORY_LABELS, BIOME_META } from "@/usermodules/biomehunt/constants/biomes.constants";
import { VoteStatus } from "@/usermodules/biomehunt/types";
import { buildForwardContainer, type ForwardBadges, type VoteRenderInfo } from "@/usermodules/biomehunt/views/forward-post.view";
import { NO_PINGS } from "@/utils/format";
import type { TestCase } from "../../registry";

/**
 * The real biome forward card (`buildForwardContainer`), previewed interactively: pick any biome and
 * any scenario (vote states, delayed, simulated, first find, no server link) from the two selects.
 * Fake data only, and this preview pings nobody.
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

function buildPreview(biome: string, scenario: Scenario, finderId: string) {
    const now = Date.now();
    const vote: VoteRenderInfo | undefined = scenario.vote && {
        ...scenario.vote,
        voteId: FAKE_VOTE_ID,
        closesAt: new Date(now + 52_000),
        decidedByUserId: finderId,
    };
    return buildForwardContainer({
        biome,
        roleId: FAKE_ROLE_ID,
        serverLink: scenario.noServerLink ? null : FAKE_SERVER_LINK,
        jumpLink: FAKE_JUMP_LINK,
        finderDiscordId: finderId,
        findCount: scenario.firstFind ? 1 : 3,
        serverFindCount: scenario.firstFind ? 1 : 41,
        lastSeenInServerAt: scenario.firstFind ? null : new Date(now - 2 * 86_400_000 - 5 * 3_600_000),
        vote,
        badges: scenario.badges,
    });
}

interface PreviewState {
    biome: string;
    scenario: string;
}

export default {
    description: "The biome forward card - pick any biome and scenario (vote states, delayed, simulated...) from selects.",
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
                        buildPreview(state.biome, SCENARIOS[state.scenario], finderId),
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
