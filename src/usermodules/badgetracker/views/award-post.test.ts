import { expect, test } from "bun:test";
import { MessageFlags } from "discord.js";
import { NO_PINGS } from "@/utils/format";
import { type AwardPostInput, buildAwardPost, buildDeletedPost, buildTestPost, resolveDescription, TEST_LINE } from "./award-post";

const base: AwardPostInput = {
    badgeId: "2124445684",
    name: "Glitch Hunter",
    description: "Someone caught the glitch again.",
    iconUrl: "https://img/x.png",
    delta: 3,
    total: 48216,
    window: { kind: "interval", minutes: 5 },
    pingRoleId: "ROLE",
    accentColor: null,
};

// biome-ignore lint/suspicious/noExplicitAny: inspecting raw JSON
function container(post: any): any {
    return post.components[0].toJSON();
}
// biome-ignore lint/suspicious/noExplicitAny: inspecting raw JSON
function first(post: any): any {
    return container(post).components[0];
}
// biome-ignore lint/suspicious/noExplicitAny: inspecting raw JSON
function text(post: any): string {
    const c = first(post);
    return c.type === 9 ? c.components[0].content : c.content;
}

test("resolveDescription", () => {
    expect(resolveDescription("mine", "theirs")).toBe("mine");
    expect(resolveDescription("  ", "theirs")).toBe("theirs");
    expect(resolveDescription(null, "theirs")).toBe("theirs");
    expect(resolveDescription("", "  ")).toBeNull();
    const cut = resolveDescription("a".repeat(301), "");
    expect(cut).toBe(`${"a".repeat(299)}…`);
});

test("buildAwardPost: exact text, flags, accent", () => {
    const post = buildAwardPost(base);
    expect(post.flags).toBe(MessageFlags.IsComponentsV2);
    expect(container(post).accent_color).toBe(0x3ba55d);
    expect(text(post)).toBe(
        "<@&ROLE>\n## [Glitch Hunter](https://www.roblox.com/badges/2124445684)\n-# Someone caught the glitch again.\n**+3** awards in the last 5 minutes\n48,216 total",
    );
    expect(first(post).type).toBe(9);
    expect(post.allowedMentions).toEqual({ parse: [], roles: ["ROLE"] });
});

test("buildAwardPost: the Subscription's color replaces the default", () => {
    expect(container(buildAwardPost({ ...base, accentColor: 0x7cf5ff })).accent_color).toBe(0x7cf5ff);
});

test("buildTestPost: marked as a test, +1 award, never pings, keeps the color", () => {
    const post = buildTestPost(
        {
            guild_id: "g",
            badge_id: "2124445684",
            ping_role_id: "ROLE",
            custom_description: null,
            accent_color: 0x7cf5ff,
            name: "Glitch Hunter",
            description: "Roblox text.",
            icon_url: null,
            awarded_count: "48216",
            deleted: false,
        },
        5,
    );
    const json = container(post);
    expect(json.accent_color).toBe(0x7cf5ff);
    expect(json.components[0].content).toBe(
        `${TEST_LINE}\n## [Glitch Hunter](https://www.roblox.com/badges/2124445684)\n-# Roblox text.\n**+1** award in the last 5 minutes\n48,216 total`,
    );
    expect(post.allowedMentions).toEqual({ parse: [], roles: [] });
});

test("buildAwardPost: singular award and minute", () => {
    const t = text(buildAwardPost({ ...base, delta: 1, window: { kind: "interval", minutes: 1 } }));
    expect(t).toContain("**+1** award in the last minute\n");
});

test("buildAwardPost: since window", () => {
    const at = new Date(1_700_000_000_000);
    const t = text(buildAwardPost({ ...base, delta: 41, window: { kind: "since", at } }));
    expect(t).toContain("**+41** awards since <t:1700000000:t>");
});

test("buildAwardPost: no role", () => {
    const post = buildAwardPost({ ...base, pingRoleId: null });
    expect(text(post).startsWith("## ")).toBe(true);
    expect(post.allowedMentions).toEqual({ parse: [], roles: [] });
});

test("buildAwardPost: description handling", () => {
    expect(text(buildAwardPost({ ...base, description: null }))).not.toContain("-#");
    expect(text(buildAwardPost({ ...base, description: "one\ntwo" }))).toContain("-# one\n-# two\n");
});

test("buildAwardPost: no icon uses a TextDisplay", () => {
    const post = buildAwardPost({ ...base, iconUrl: null });
    expect(first(post).type).toBe(10);
    expect(text(post)).toContain("## [Glitch Hunter]");
});

test("buildAwardPost: escapes the name", () => {
    expect(text(buildAwardPost({ ...base, name: "A*B_c" }))).toContain("[A\\*B\\_c](");
});

test("buildDeletedPost", () => {
    const post = buildDeletedPost({ name: "Old Event Badge", lastCount: 3902, iconUrl: null });
    expect(container(post).accent_color).toBe(0xda373c);
    expect(post.flags).toBe(MessageFlags.IsComponentsV2);
    expect(text(post)).toBe("## Old Event Badge\nThis badge was deleted on Roblox and is no longer tracked here.\nLast count: 3,902");
    expect(post.allowedMentions).toEqual(NO_PINGS);
    expect(text(buildDeletedPost({ name: "X", lastCount: null, iconUrl: "https://i" }))).not.toContain("Last count");
});

test("buildAwardPost: CRLF and blank description lines give no empty quote lines", () => {
    const post = buildAwardPost({ ...base, description: "a\r\n\r\nb" });
    expect(text(post)).toContain("-# a\n-# b\n");
    expect(text(post)).not.toContain("-# \n");
    expect(text(post)).not.toContain("\r");
});
