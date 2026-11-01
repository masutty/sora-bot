import { MessageFlags } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { defineView, type ViewPayload } from "@/define";
import {
    BIOME_CATEGORY_LABELS,
    getBiomeMeta,
    getEnabledBiomes,
    MAX_DISCORD_CHOICES,
} from "@/usermodules/biomehunt/constants/biomes.constants";
import { CASUAL_VOTE_PREFIX } from "@/usermodules/biomehunt/services/casual-vote.service";
import { VoteStatus } from "@/usermodules/biomehunt/types";
import { buildForwardContainer, type ForwardBadges, type VoteRenderInfo } from "@/usermodules/biomehunt/views/forward-post.view";
import { buildMirrorContainer, type MirrorVoteInfo } from "@/usermodules/biomehunt/views/network-mirror.view";
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
    vote?: Omit<VoteRenderInfo, "voteId" | "decidedByUserId">;
    badges?: ForwardBadges;
    firstFind?: boolean;
    noServerLink?: boolean;
    /** Render the Network Mirror of the picked biome instead of the local card. */
    network?: { vote: MirrorVoteInfo; originName?: string; home?: boolean };
}

const SCENARIOS: Record<string, Scenario> = {
    plain: {
        label: "Regular find",
        description: "Casual vote buttons: a live count, nothing is decided",
        vote: { status: VoteStatus.OPEN, tally: { real: 3, fake: 1 }, prefix: CASUAL_VOTE_PREFIX, hideId: true },
    },
    "vote-open": {
        label: "Vote - open",
        description: "Rare biome right after it's found",
        vote: { status: VoteStatus.OPEN, tally: { real: 2, fake: 0 } },
    },
    "vote-real": {
        label: "Vote - ruled real",
        description: "Community voted real",
        vote: { status: VoteStatus.COMMUNITY_REAL, tally: { real: 4, fake: 1 } },
    },
    "vote-fake": {
        label: "Vote - ruled fake",
        description: "Community voted fake",
        vote: { status: VoteStatus.COMMUNITY_FAKE, tally: { real: 1, fake: 4 } },
    },
    "vote-tie": {
        label: "Vote - tie",
        description: "Same number of real/fake votes",
        vote: { status: VoteStatus.TIE, tally: { real: 2, fake: 2 } },
    },
    "vote-none": {
        label: "Vote - no votes",
        description: "Nobody voted before it closed",
        vote: { status: VoteStatus.NO_VOTES, tally: { real: 0, fake: 0 } },
    },
    "vote-admin-real": {
        label: "Vote - admin confirmed",
        description: "An administrator ruled it real",
        vote: { status: VoteStatus.ADMIN_CONFIRMED, tally: { real: 1, fake: 0 } },
    },
    "vote-admin-fake": {
        label: "Vote - admin denied",
        description: "An administrator ruled it fake",
        vote: { status: VoteStatus.ADMIN_DENIED, tally: { real: 0, fake: 1 } },
    },
    delayed: { label: "Delayed forward", description: "Sent to the delayed channel (⏳ + ?)", badges: { delayed: true } },
    simulated: { label: "Simulated (dry run)", description: "/owner simulate-biome - banner + 🧪", badges: { simulated: true } },
    first: { label: "First find ever", description: "Their first, and the server's first", firstFind: true },
    "net-open": {
        label: "Network - vote open",
        description: "A Network Mirror with the live count",
        network: { vote: { status: "open", scoreboard: { real: 5, fake: 1 } } },
    },
    "net-real": {
        label: "Network - ruled real",
        description: "A closed Network vote",
        network: { vote: { status: "real", scoreboard: { real: 12, fake: 3 } } },
    },
    "net-long": {
        label: "Network - long server name",
        description: "The origin name is cut to 18 characters",
        network: {
            vote: { status: "open", scoreboard: { real: 0, fake: 0 } },
            originName: "The Official Community Hub of the Very Long Named Server",
        },
    },
    "net-home": {
        label: "Network - home",
        description: "The origin's own server: Home badge, no ping",
        network: { vote: { status: "open", scoreboard: { real: 2, fake: 0 } }, home: true },
    },
    "no-link": { label: "No private server link", description: "Macro didn't send a server link", noServerLink: true },
};

function buildPreview(biome: string, scenario: Scenario, finderId: string) {
    const now = Date.now();
    const vote: VoteRenderInfo | undefined = scenario.vote && {
        ...scenario.vote,
        voteId: FAKE_VOTE_ID,
        decidedByUserId: finderId,
    };
    if (scenario.network) {
        return buildMirrorContainer({
            post: {
                id: FAKE_VOTE_ID,
                biome,
                origin_name: scenario.network.originName ?? "illusion.",
                origin_icon_url: null,
                invite_url: "https://discord.gg/preview",
                server_link: FAKE_SERVER_LINK,
            },
            roleId: FAKE_ROLE_ID,
            vote: scenario.network.vote,
            home: scenario.network.home,
            flavorText: getBiomeMeta(biome)?.flavorText,
        });
    }
    return buildForwardContainer({
        biome,
        roleId: FAKE_ROLE_ID,
        serverLink: scenario.noServerLink ? null : FAKE_SERVER_LINK,
        jumpLink: FAKE_JUMP_LINK,
        finderDiscordId: finderId,
        findCount: scenario.firstFind ? 1 : 3,
        serverFindCount: scenario.firstFind ? 1 : 41,
        sentAt: new Date(now - 2 * 3_600_000),
        vote,
        badges: scenario.badges,
        // Preview only for now - real forwards don't pass it yet.
        flavorText: getBiomeMeta(biome)?.flavorText,
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
                        getEnabledBiomes()
                            .slice(0, MAX_DISCORD_CHOICES)
                            .map((meta) => ({
                                label: meta.label,
                                value: meta.key,
                                description: BIOME_CATEGORY_LABELS[meta.category],
                                default: meta.key === state.biome,
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
