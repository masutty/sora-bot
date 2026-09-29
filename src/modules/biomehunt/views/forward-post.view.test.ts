import { expect, test } from "bun:test";
import { SeparatorSpacingSize } from "discord.js";
import { VoteStatus } from "../types";
import {
    buildForwardContainer,
    buildForwardInfoText,
    FORWARD_INFO_PREFIX,
    forwardInfoCustomId,
    parseForwardInfoParts,
} from "./forward-post.view";

type Json = { type?: number; content?: string; spacing?: number; divider?: boolean; custom_id?: string; url?: string; components?: Json[] };

/** Every component in the tree, depth-first (the container itself, then every descendant at any depth - sections, action rows, buttons, text displays, ...). */
function flatten(json: Json): Json[] {
    const out: Json[] = [json];
    for (const child of json.components ?? []) out.push(...flatten(child));
    return out;
}

function textOf(json: Json): string {
    return flatten(json)
        .map((c) => c.content ?? "")
        .filter(Boolean)
        .join("\n");
}

function customIdsOf(json: Json): string[] {
    return flatten(json)
        .map((c) => c.custom_id)
        .filter((id): id is string => Boolean(id));
}

const BASE = { biome: "GLITCHED", roleId: null, serverLink: null, jumpLink: "https://discord.com/channels/g/c/m" };

test("no vote block at all when vote is omitted (non-rare forward)", () => {
    const json = buildForwardContainer(BASE).toJSON();
    expect(textOf(json)).not.toContain("Vote ID");
});

test("open vote: hides the tally, shows the count + closes-at, the vote id, and Real/Fake buttons", () => {
    const closesAt = new Date(Date.now() + 60_000);
    const json = buildForwardContainer({
        ...BASE,
        vote: { voteId: "abc12345", status: VoteStatus.OPEN, closesAt, voteCount: 3 },
    }).toJSON();

    const text = textOf(json);
    expect(text).toContain("3 votes");
    expect(text).toContain("closes <t:");
    expect(text).toMatch(/Vote ID: `abc12345` • 3 votes • closes <t:\d+:R>/);
    expect(text).not.toContain("Admins:");
    expect(text).not.toMatch(/\(\d+\/\d+\)/); // the real/fake split never appears while open

    const customIds = customIdsOf(json);
    expect(customIds).toContain("biomehunt:vote:abc12345:real");
    expect(customIds).toContain("biomehunt:vote:abc12345:fake");
});

test("a closed vote hides the buttons and shows the real/fake split", () => {
    const json = buildForwardContainer({
        ...BASE,
        vote: {
            voteId: "abc12345",
            status: VoteStatus.COMMUNITY_REAL,
            closesAt: new Date(),
            voteCount: 5,
            tally: { real: 3, fake: 2 },
        },
    }).toJSON();

    const text = textOf(json);
    expect(text).toContain("Ruled real via voting (3/2)");
    expect(customIdsOf(json).some((id) => id.startsWith("biomehunt:vote:"))).toBe(false);
});

test("dividers use Large separator spacing (the top spacer under the vote id is a small blank gap)", () => {
    const json = buildForwardContainer({
        ...BASE,
        vote: { voteId: "abc12345", status: VoteStatus.OPEN, closesAt: new Date(), voteCount: 0 },
    }).toJSON();

    const separators = flatten(json).filter((c) => c.spacing !== undefined && c.divider !== false);
    expect(separators.length).toBeGreaterThan(0);
    for (const sep of separators) expect(sep.spacing).toBe(SeparatorSpacingSize.Large);
});

test("admin_confirmed: shows who decided, no closes-at line, and the link row is unaffected", () => {
    const json = buildForwardContainer({
        ...BASE,
        vote: { voteId: "abc12345", status: VoteStatus.ADMIN_CONFIRMED, closesAt: new Date(), voteCount: 0, decidedByUserId: "admin-1" },
    }).toJSON();

    const text = textOf(json);
    expect(text).toContain("Ruled real by <@admin-1>");
    expect(text).not.toContain("closes <t:");
    expect(flatten(json).some((c) => c.url === BASE.jumpLink)).toBe(true);
});

test("the vote id line is the container's FIRST component (top of the card, like the profile's level line)", () => {
    const json = buildForwardContainer({
        ...BASE,
        vote: { voteId: "abc12345", status: VoteStatus.OPEN, closesAt: new Date(Date.now() + 60_000), voteCount: 0 },
    }).toJSON() as Json;
    expect(json.components?.[0]?.content).toStartWith("-# Vote ID: `abc12345`");
});

test("no badges: no badges block, no simulated banner, no '?' button", () => {
    const json = buildForwardContainer(BASE).toJSON();
    expect(textOf(json)).not.toContain("**Badges**");
    expect(textOf(json)).not.toContain("SIMULATED");
    expect(customIdsOf(json).some((id) => id.startsWith(FORWARD_INFO_PREFIX))).toBe(false);
});

test("delayed badge: a divider, then a profile-style badges block, plus a '?' button", () => {
    const json = buildForwardContainer({ ...BASE, badges: { delayed: true } }).toJSON() as Json;
    const components = json.components ?? [];
    const blockIndex = components.findIndex((c) => c.content?.startsWith("**Badges**"));
    expect(components[blockIndex]?.content).toBe("**Badges**\n⏳");
    expect(components[blockIndex - 1]?.divider).not.toBe(false);
    expect(textOf(json)).not.toContain("SIMULATED FORWARD");
    expect(customIdsOf(json)).toContain(`${FORWARD_INFO_PREFIX}:1:0`);
});

test("simulated badge: a one-line banner on top, a divider under it, and the badge in the badges block", () => {
    const json = buildForwardContainer({ ...BASE, badges: { delayed: true, simulated: true } }).toJSON() as Json;
    const top = (json.components ?? []).slice(0, 2);
    expect(top[0].content).toBe("### 🧪 SIMULATED FORWARD - TESTING ONLY");
    expect(top[1].divider).toBe(true);
    expect(textOf(json)).toContain("**Badges**\n⏳ 🧪");
    expect(customIdsOf(json)).toContain(`${FORWARD_INFO_PREFIX}:1:1`);
});

test("forward info id round-trips, rejects malformed parts, and the explanation stays vague (no delay length)", () => {
    const badges = { delayed: true, simulated: true };
    const parts = forwardInfoCustomId(badges)
        .slice(FORWARD_INFO_PREFIX.length + 1)
        .split(":");
    expect(parseForwardInfoParts(parts)).toEqual(badges);
    expect(parseForwardInfoParts(["x", "1"])).toBeNull();
    expect(parseForwardInfoParts([])).toBeNull();

    const text = buildForwardInfoText(badges);
    expect(text).toContain("**Delayed**");
    expect(text).toContain("**Simulated**");
    expect(text).not.toMatch(/\d+s\b|<t:/);
});
