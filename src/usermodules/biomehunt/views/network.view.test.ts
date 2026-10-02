import { expect, test } from "bun:test";
import type { ContainerBuilder } from "discord.js";
import { type NetworkGuildRow, NetworkStatus } from "../types";
import {
    buildEligibilityContainer,
    buildJoinRequestContainer,
    buildNetworkOverviewPages,
    buildStatusContainer,
    formatAlertLines,
    type OverviewServer,
    type OverviewStats,
} from "./network.view";

const json = (c: ContainerBuilder) => JSON.stringify(c.toJSON());
const card = { activeMembers: 4, macroHours7d: 31.5, macroHours30d: 120 };

function row(overrides: Partial<NetworkGuildRow> = {}): NetworkGuildRow {
    return {
        guild_id: "g1",
        status: NetworkStatus.MEMBER,
        forced: false,
        network_channel_id: "net",
        staff_channel_id: "staff",
        staff_role_id: "role",
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

test("buildJoinRequestContainer: an undecided request carries Approve/Reject for its guild", () => {
    const out = json(buildJoinRequestContainer({ guildId: "g1", guildName: "Sol Hunters", card }));
    expect(out).toContain("biomehunt:network-review:g1:approve");
    expect(out).toContain("biomehunt:network-review:g1:reject");
    expect(out).toContain("Sol Hunters");
    expect(out).toContain("31.5h");
});

test("buildJoinRequestContainer: a decided request has no buttons and names who decided", () => {
    const out = json(
        buildJoinRequestContainer({ guildId: "g1", guildName: "Sol Hunters", card, decided: { approved: true, byUserId: "o1" } }),
    );
    expect(out).not.toContain("network-review");
    expect(out).toContain("Approved by <@o1>");
});

test("buildEligibilityContainer: one line per gap", () => {
    const out = json(buildEligibilityContainer([{ kind: "staff" }, { kind: "network_channel" }]));
    expect(out).toContain("not eligible");
    expect(out).toContain("A staff channel and a staff role");
    expect(out).toContain("A Network channel");
});

test("buildStatusContainer: no row reads as not in the Network", () => {
    const out = json(buildStatusContainer({ row: null, gaps: [], card, pings: [] }));
    expect(out).toContain("Not in the Network");
});

test("buildStatusContainer: a forced member says so and shows its config", () => {
    const out = json(buildStatusContainer({ row: row({ forced: true }), gaps: [], card, pings: [] }));
    expect(out).toContain("Member (forced by the bot owner)");
    expect(out).toContain("<#net>");
    expect(out).toContain("All requirements met");
});

test("formatAlertLines: newest first as given, one line each with relative time and kind, long details cut", () => {
    const at = new Date("2026-10-02T12:00:00Z");
    const long = "x".repeat(400);
    const out = formatAlertLines([
        {
            id: 1,
            kind: "fake_verdict",
            guild_id: "g",
            discord_user_id: "u",
            post_id: "p",
            details: "first line\nsecond line",
            notified: true,
            created_at: at,
        },
        { id: 2, kind: "multi_macro", guild_id: "g", discord_user_id: "u", post_id: null, details: long, notified: false, created_at: at },
    ]);
    const lines = out.split("\n");
    expect(lines[0]).toBe(`- <t:${at.getTime() / 1000}:R> \`fake_verdict\` first line`);
    expect(lines[1].length).toBeLessThan(260);
    expect(formatAlertLines([])).toBe("No alerts.");
});

test("buildJoinRequestContainer: the server's name links to its invite when it has one", () => {
    const out = json(buildJoinRequestContainer({ guildId: "g1", guildName: "Sol Hunters", inviteUrl: "https://discord.gg/sol", card }));
    expect(out).toContain("[Sol Hunters](https://discord.gg/sol)");
});

const overviewServer = (overrides: Partial<OverviewServer> = {}): OverviewServer => ({
    guildId: "111",
    name: "Sol Hunters",
    inviteUrl: "https://discord.gg/sol",
    forced: false,
    hasChannel: true,
    botInGuild: true,
    ...overrides,
});

const overviewStats: OverviewStats = {
    posts7d: 12,
    fakeVerdicts7d: 1,
    multiMacro7d: 2,
    queuedPosts: 0,
    openVotes: 3,
    bannedGuilds: 1,
    bannedUsers: 4,
};

const pagesJson = (pages: ContainerBuilder[]) => pages.map((p) => json(p));

test("buildNetworkOverviewPages: a summary page first, then members and pending requests on their own pages", () => {
    const pages = pagesJson(
        buildNetworkOverviewPages({
            members: [
                overviewServer({ name: "Zeta", guildId: "333", inviteUrl: null, forced: true }),
                overviewServer({ hasChannel: false, botInGuild: false }),
            ],
            pending: [overviewServer({ name: "Newcomers", guildId: "222", inviteUrl: null })],
            stats: overviewStats,
        }),
    );
    expect(pages).toHaveLength(3);
    expect(pages[0]).toContain("Members: **2**");
    expect(pages[0]).toContain("Pending requests: **1**");
    expect(pages[0]).toContain("**12** posts");
    expect(pages[0]).toContain("**3** open votes");

    expect(pages[1]).toContain("Members (2)");
    expect(pages[1].indexOf("Sol Hunters")).toBeLessThan(pages[1].indexOf("Zeta"));
    expect(pages[1]).toContain("[Sol Hunters](https://discord.gg/sol) · `111`");
    expect(pages[1]).toContain("no Network channel");
    expect(pages[1]).toContain("bot not in server");
    expect(pages[1]).toContain("forced");
    expect(pages[1]).not.toContain("active");

    expect(pages[2]).toContain("Pending requests (1)");
    expect(pages[2]).toContain("**Newcomers** · `222`");
});

test("buildNetworkOverviewPages: members are split 15 per page, and no emojis anywhere", () => {
    const members = Array.from({ length: 16 }, (_, i) =>
        overviewServer({ name: `Server ${String(i).padStart(2, "0")}`, guildId: String(i) }),
    );
    const pages = pagesJson(buildNetworkOverviewPages({ members, pending: [], stats: overviewStats }));
    expect(pages).toHaveLength(3);
    expect(pages[1]).toContain("Server 14");
    expect(pages[1]).not.toContain("Server 15");
    expect(pages[2]).toContain("Server 15");
    expect(pages.join("")).not.toMatch(/\p{Extended_Pictographic}/u);
});

test("buildNetworkOverviewPages: an empty Network is just the summary page", () => {
    const pages = pagesJson(buildNetworkOverviewPages({ members: [], pending: [], stats: overviewStats }));
    expect(pages).toHaveLength(1);
    expect(pages[0]).toContain("Members: **0**");
});
