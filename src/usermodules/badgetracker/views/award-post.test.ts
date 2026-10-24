import { expect, test } from "bun:test";
import { MessageFlags } from "discord.js";
import { NO_PINGS } from "@/utils/format";
import { type AwardPostInput, buildAwardPost, buildDeletedPost, buildTestPost, resolveDescription, TEST_LINE } from "./award-post";

const FROM = new Date(1_700_000_000_000);
const TO = new Date(1_700_000_300_000);
const FOOTER = "-# <t:1700000000:t> to <t:1700000300:t> • <t:1700000300:R>";

const base: AwardPostInput = {
    badgeId: "2124445684",
    name: "Glitch Hunter",
    description: "Someone caught the glitch again.",
    iconUrl: "https://img/x.png",
    delta: 3,
    total: 48216,
    window: { from: FROM, to: TO },
    pingRoleId: "ROLE",
    accentColor: null,
};

// biome-ignore lint/suspicious/noExplicitAny: inspecting raw JSON
type Json = any;

function json(post: Json): Json[] {
    return post.components.map((c: Json) => c.toJSON());
}
/** The card: the last top-level component. */
function card(post: Json): Json {
    return json(post).at(-1);
}
/** The text blocks beside the icon (a Section), or the card's leading TextDisplays without one. */
function top(post: Json): string[] {
    const first = card(post).components[0];
    if (first.type === 9) return first.components.map((t: Json) => t.content);
    const texts: string[] = [];
    for (const c of card(post).components) {
        if (c.type !== 10) break;
        texts.push(c.content);
    }
    return texts;
}
/** Each TextDisplay that follows a divider, in order. */
function below(post: Json): string[] {
    const comps = card(post).components;
    return comps.flatMap((c: Json, i: number) => (i > 0 && comps[i - 1].type === 14 && comps[i - 1].divider ? [c.content] : []));
}

test("resolveDescription", () => {
    expect(resolveDescription("mine", "theirs")).toBe("mine");
    expect(resolveDescription("  ", "theirs")).toBe("theirs");
    expect(resolveDescription(null, "theirs")).toBe("theirs");
    expect(resolveDescription("", "  ")).toBeNull();
    const cut = resolveDescription("a".repeat(301), "");
    expect(cut).toBe(`${"a".repeat(299)}…`);
});

test("buildAwardPost: ping above; title and diff beside the icon; description and span below dividers", () => {
    const post = buildAwardPost(base);
    expect(post.flags).toBe(MessageFlags.IsComponentsV2);
    expect(json(post)[0]).toMatchObject({ type: 10, content: "<@&ROLE>" });
    expect(card(post).accent_color).toBe(0x3ba55d);
    expect(card(post).components.map((c: Json) => c.type)).toEqual([9, 14, 10, 14, 10]);
    expect(top(post)).toEqual([
        "## [Glitch Hunter](https://www.roblox.com/badges/2124445684)",
        "```diff\n+3 awards\n  48,213 → 48,216\n```",
    ]);
    expect(below(post)).toEqual(["-# Someone caught the glitch again.", FOOTER]);
    expect(post.allowedMentions).toEqual({ parse: [], roles: ["ROLE"] });
});

test("buildAwardPost: the Subscription's color replaces the default", () => {
    expect(card(buildAwardPost({ ...base, accentColor: 0x7cf5ff })).accent_color).toBe(0x7cf5ff);
});

test("buildAwardPost: no role leaves only the card", () => {
    const post = buildAwardPost({ ...base, pingRoleId: null });
    expect(json(post)).toHaveLength(1);
    expect(post.allowedMentions).toEqual({ parse: [], roles: [] });
});

test("buildAwardPost: singular award, thousands separators", () => {
    expect(top(buildAwardPost({ ...base, delta: 1, total: 1000 }))[1]).toBe("```diff\n+1 award\n  999 → 1,000\n```");
    expect(top(buildAwardPost({ ...base, delta: 1234 }))[1]).toBe("```diff\n+1,234 awards\n  46,982 → 48,216\n```");
});

test("buildAwardPost: no description leaves out its line and divider", () => {
    const post = buildAwardPost({ ...base, description: null });
    expect(card(post).components.map((c: Json) => c.type)).toEqual([9, 14, 10]);
    expect(below(post)).toEqual([FOOTER]);
});

test("buildAwardPost: multi-line, CRLF and blank description lines", () => {
    expect(below(buildAwardPost({ ...base, description: "one\ntwo" }))[0]).toBe("-# one\n-# two");
    const desc = below(buildAwardPost({ ...base, description: "a\r\n\r\nb" }))[0];
    expect(desc).toBe("-# a\n-# b");
});

test("buildAwardPost: no icon puts the title and diff straight in the container", () => {
    const post = buildAwardPost({ ...base, iconUrl: null });
    expect(card(post).components.map((c: Json) => c.type)).toEqual([10, 10, 14, 10, 14, 10]);
    expect(top(post)[0]).toContain("## [Glitch Hunter]");
});

test("buildAwardPost: escapes the name", () => {
    expect(top(buildAwardPost({ ...base, name: "A*B_c" }))[0]).toContain("[A\\*B\\_c](");
});

test("buildTestPost: marked above the card, +1 award over the last interval, never pings, keeps the color", () => {
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
        TO,
    );
    expect(json(post)[0]).toMatchObject({ type: 10, content: TEST_LINE });
    expect(card(post).accent_color).toBe(0x7cf5ff);
    expect(top(post)[1]).toBe("```diff\n+1 award\n  48,215 → 48,216\n```");
    expect(below(post)).toEqual(["-# Roblox text.", FOOTER]);
    expect(post.allowedMentions).toEqual({ parse: [], roles: [] });
});

test("buildDeletedPost", () => {
    const post = buildDeletedPost({ name: "Old Event Badge", lastCount: 3902, iconUrl: null });
    expect(card(post).accent_color).toBe(0xda373c);
    expect(post.flags).toBe(MessageFlags.IsComponentsV2);
    expect(top(post)).toEqual(["## Old Event Badge\nThis badge was deleted on Roblox and is no longer tracked here.\nLast count: 3,902"]);
    expect(post.allowedMentions).toEqual(NO_PINGS);
    expect(top(buildDeletedPost({ name: "X", lastCount: null, iconUrl: "https://i" }))[0]).not.toContain("Last count");
});
