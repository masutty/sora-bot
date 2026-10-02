import { MessageFlags } from "discord.js";
import { buildNetworkOverviewPages, type OverviewServer } from "@/usermodules/biomehunt/views/network.view";
import { NO_PINGS } from "@/utils/format";
import type { TestCase, TestPayload } from "../../registry";

/**
 * `/bh-owner network overview` with fake data - the summary page, then 18 members (two pages: a
 * forced one, one with problems) and a pending request.
 */
const server = (i: number, overrides: Partial<OverviewServer> = {}): OverviewServer => ({
    guildId: `1000000000000000${String(i).padStart(2, "0")}`,
    name: `Server ${String(i).padStart(2, "0")}`,
    inviteUrl: i % 3 === 0 ? null : "https://discord.gg/discord-developers",
    forced: false,
    hasChannel: true,
    botInGuild: true,
    ...overrides,
});

export default {
    description: "The Network overview pages (/bh-owner network overview) with fake servers and numbers.",
    pages: (): TestPayload[] =>
        buildNetworkOverviewPages({
            members: [
                ...Array.from({ length: 16 }, (_, i) => server(i + 1)),
                server(17, { name: "Test Lab", forced: true }),
                server(18, { name: "Glitch Chasers", hasChannel: false, botInGuild: false }),
            ],
            pending: [server(19, { name: "Newcomers", inviteUrl: null })],
            stats: { posts7d: 42, fakeVerdicts7d: 1, multiMacro7d: 3, queuedPosts: 0, openVotes: 2, bannedGuilds: 0, bannedUsers: 1 },
        }).map((container) => ({ flags: MessageFlags.IsComponentsV2, components: [container], allowedMentions: NO_PINGS })),
} satisfies TestCase;
