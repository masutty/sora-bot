import { expect, test } from "bun:test";
import type { MessageCreateOptions } from "discord.js";
import { type NetworkGuildRow, NetworkStatus } from "../types";
import { type AnnounceDeps, buildAnnouncementContainer, sendNetworkAnnouncement } from "./network-announce.service";

function guildRow(guildId: string, overrides: Partial<NetworkGuildRow> = {}): NetworkGuildRow {
    return {
        guild_id: guildId,
        status: NetworkStatus.MEMBER,
        forced: false,
        network_channel_id: `net-${guildId}`,
        staff_channel_id: null,
        staff_role_id: null,
        announce_role_id: null,
        invite_url: null,
        requested_at: null,
        approved_at: null,
        decided_by: null,
        low_activity_checks: 0,
        last_activity_check: null,
        created_at: new Date(),
        updated_at: new Date(),
        ...overrides,
    };
}

test("sendNetworkAnnouncement: posts to every member's Network channel, pinging only its announcements role", async () => {
    const sent: Array<{ channelId: string; payload: MessageCreateOptions }> = [];
    const deps: AnnounceDeps = {
        getMemberNetworkGuilds: async () => [
            guildRow("g1", { announce_role_id: "ann" }),
            guildRow("g2"),
            guildRow("g3", { network_channel_id: null }),
        ],
        send: async (channelId, payload) => {
            if (channelId === "net-g2") return false;
            sent.push({ channelId, payload });
            return true;
        },
    };
    expect(await sendNetworkAnnouncement("Hello Network", deps)).toEqual({ sent: 1, total: 2 });
    expect(sent[0].channelId).toBe("net-g1");
    expect(sent[0].payload.allowedMentions).toEqual({ parse: [], roles: ["ann"] });
    expect(JSON.stringify(sent[0].payload.components)).toContain("Hello Network");
});

test("buildAnnouncementContainer: just the notice - no title, an informative blue, and a small footer saying where it comes from", () => {
    const card = buildAnnouncementContainer("Maintenance tonight at 22h.").toJSON() as {
        accent_color?: number;
        components: Array<{ content?: string }>;
    };
    expect(card.accent_color).toBe(0x0ea5e9);
    expect(card.components[0].content).toBe("Maintenance tonight at 22h.");
    expect(JSON.stringify(card)).not.toContain("BiomeHunt Network announcement");
    expect(card.components.at(-1)?.content).toContain("-# 📢");

    const pinged = buildAnnouncementContainer("Hi", "ann").toJSON() as { components: Array<{ content?: string }> };
    expect(pinged.components[0].content).toBe("<@&ann>");
});
