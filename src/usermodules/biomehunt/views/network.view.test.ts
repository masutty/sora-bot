import { expect, test } from "bun:test";
import type { ContainerBuilder } from "discord.js";
import { type NetworkGuildRow, NetworkStatus } from "../types";
import { buildEligibilityContainer, buildJoinRequestContainer, buildStatusContainer, formatAlertLines } from "./network.view";

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
