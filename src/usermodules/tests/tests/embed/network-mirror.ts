import { MessageFlags } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { defineView, type ViewPayload } from "@/define";
import { formatBiomeName } from "@/usermodules/biomehunt/constants/biomes.constants";
import { NETWORK_BIOMES } from "@/usermodules/biomehunt/services/network-eligibility.service";
import { buildMirrorContainer, type MirrorPost, type MirrorVoteInfo } from "@/usermodules/biomehunt/views/network-mirror.view";
import { NO_PINGS } from "@/utils/format";
import type { TestCase } from "../../registry";

/**
 * The Network Mirror (`buildMirrorContainer`) - how a rare biome from another server looks in a
 * Member Server's Network channel. Pick any Network biome and scenario (vote states, test relay,
 * no invite) from the two selects. Fake data only; the vote buttons here go to a post that doesn't
 * exist (they answer "no longer available"), and this preview pings nobody.
 */
const FAKE_ROLE_ID = "1";
const FAKE_INVITE = "https://discord.gg/discord-developers";
const FAKE_SERVER_LINK = "https://www.roblox.com/share?code=PREVIEW&type=Server";
const BOARD = { servers: { real: 3, fake: 1 }, people: { real: 11, fake: 2 } };

interface Scenario {
    label: string;
    description: string;
    vote?: MirrorVoteInfo;
    simulated?: boolean;
    noInvite?: boolean;
    withRole?: boolean;
}

const SCENARIOS: Record<string, Scenario> = {
    open: {
        label: "Vote - open",
        description: "Right after it arrives, with this server's ping role",
        vote: { status: "open" },
        withRole: true,
    },
    real: { label: "Vote - real", description: "The Network voted it real", vote: { status: "real", scoreboard: BOARD } },
    fake: {
        label: "Vote - fake",
        description: "The Network voted it fake",
        vote: { status: "fake", scoreboard: { servers: { real: 0, fake: 2 }, people: { real: 1, fake: 6 } } },
    },
    inconclusive: {
        label: "Vote - inconclusive",
        description: "Fewer than 2 servers decided",
        vote: { status: "inconclusive", scoreboard: { servers: { real: 1, fake: 0 }, people: { real: 2, fake: 0 } } },
    },
    "no-invite": { label: "Origin without invite", description: "Name shows as plain text", vote: { status: "open" }, noInvite: true },
    simulated: { label: "Test relay", description: "simulate-biome network / network_relays - 🧪 + 🌐, no vote", simulated: true },
};

interface PreviewState {
    biome: string;
    scenario: string;
}

function buildPreview(state: PreviewState, originName: string): ViewPayload["components"] {
    const scenario = SCENARIOS[state.scenario];
    const post: MirrorPost = {
        id: "preview0",
        biome: state.biome,
        origin_name: originName,
        origin_icon_url: null,
        invite_url: scenario.noInvite ? null : FAKE_INVITE,
        server_link: FAKE_SERVER_LINK,
    };
    return [
        buildMirrorContainer({ post, roleId: scenario.withRole ? FAKE_ROLE_ID : null, vote: scenario.vote, simulated: scenario.simulated }),
    ];
}

export default {
    description: "The Network Mirror - a rare biome relayed from another server; pick biome and scenario from selects.",
    view(client: BotClient) {
        const originName = client.guilds.cache.first()?.name ?? "Sol Hunters";
        return defineView<PreviewState, void, void>({
            name: "tests.network-mirror",
            initial: () => ({ biome: "GLITCHED", scenario: "open" }),
            render: (state, kit): ViewPayload => {
                const biomeSelect = kit.stringSelect("biome", (s) =>
                    s
                        .setPlaceholder("Biome")
                        .addOptions(
                            NETWORK_BIOMES.map((value) => ({ label: formatBiomeName(value), value, default: value === state.biome })),
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
                    components: [...(buildPreview(state, originName) ?? []), kit.row(biomeSelect), kit.row(scenarioSelect)],
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
