import { expect, test } from "bun:test";
import { SeparatorSpacingSize } from "discord.js";
import { BIOME_META } from "../constants/biomes.constants";
import { VoteStatus } from "../types";
import {
    buildForwardContainer,
    buildForwardInfoContainer,
    FORWARD_INFO_PREFIX,
    forwardBadgeEmojis,
    forwardInfoCustomId,
    forwardMentions,
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
    expect(text).toContain("Is this biome real?** · 3 votes · voting closes <t:");
    expect(text).toContain("-# Vote `abc12345`");
    expect(text).not.toContain("Admins:");
    expect(text).not.toContain("`✅ "); // the real/fake split never appears while open

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
    expect(text).toContain("✅ Marked as real by community voting `✅ 3` `❌ 2`");
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
    expect(text).toContain("✅ Marked as real by <@admin-1>");
    expect(text).not.toContain("voting closes");
    expect(flatten(json).some((c) => c.url === BASE.jumpLink)).toBe(true);
});

test("the byline opens the card: 'Found by' first, the vote id after it as secondary info", () => {
    const text = textOf(
        buildForwardContainer({
            ...BASE,
            finderDiscordId: "finder-1",
            vote: { voteId: "abc12345", status: VoteStatus.OPEN, closesAt: new Date(Date.now() + 60_000), voteCount: 0 },
        }).toJSON(),
    );
    expect(text).toStartWith("-# Found by <@finder-1> · Vote `abc12345`\n");
});

test("no badges: no badge emojis, no simulated banner, no '?' button", () => {
    const json = buildForwardContainer(BASE).toJSON();
    expect(textOf(json)).not.toContain("⏳");
    expect(textOf(json)).not.toContain("SIMULATED");
    expect(customIdsOf(json).some((id) => id.startsWith(FORWARD_INFO_PREFIX))).toBe(false);
});

test("no server link: the biome title is plain text, not a broken `[name](null)` link", () => {
    expect(textOf(buildForwardContainer(BASE).toJSON())).not.toContain("(null)");
});

test("delayed badge: divider, then just the emojis (no title) sitting directly on top of the buttons row, plus a '?' button", () => {
    const json = buildForwardContainer({ ...BASE, badges: { delayed: true } }).toJSON() as Json;
    const components = json.components ?? [];
    const [divider, emojis, buttons] = components.slice(-3);
    expect(divider.divider).not.toBe(false);
    expect(emojis.content).toBe("⏳");
    expect(buttons.components?.some((b) => b.custom_id === `${FORWARD_INFO_PREFIX}:1:0`)).toBe(true);
    expect(textOf(json)).not.toContain("Badges");
    expect(textOf(json)).not.toContain("SIMULATED FORWARD");
});

test("simulated badge: a one-line banner on top, a divider under it, and the emoji above the buttons", () => {
    const json = buildForwardContainer({ ...BASE, badges: { delayed: true, simulated: true } }).toJSON() as Json;
    const top = (json.components ?? []).slice(0, 2);
    expect(top[0].content).toBe("### 🧪 SIMULATED FORWARD - TESTING ONLY");
    expect(top[1].divider).toBe(true);
    expect((json.components ?? []).at(-2)?.content).toBe("⏳ 🧪");
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

    const text = textOf(buildForwardInfoContainer(badges).toJSON() as Json);
    expect(text).toContain("## Extra information");
    expect(text).toContain("- `⏳ Delayed`\n> This forward was sent with a delay.");
    expect(text).toContain("- `🧪 Simulated`\n> Not real");
    expect(text).not.toMatch(/\d+s\b|<t:/);
    expect(textOf(buildForwardInfoContainer({ delayed: true }).toJSON() as Json)).not.toContain("Simulated");
});

const STATS = { finderDiscordId: "finder-1", findCount: 3, serverFindCount: 41, lastSeenInServerAt: new Date(1_700_000_000_000) };

test("non-rare biome: byline, plain biome-name title, both counts, then 'Last one'", () => {
    const text = textOf(buildForwardContainer({ ...BASE, biome: "HELL", ...STATS }).toJSON());
    expect(text).not.toContain("🎉");
    expect(text).toContain("-# Found by <@finder-1>\n# He");
    expect(text).toContain("\nPersonal find **#3** · Server find **#41**\n-# Last one <t:1700000000:R>");
});

test("rare biome: '🎉 X found!' title - the finder stays in the byline, never on the title or counts line", () => {
    const text = textOf(buildForwardContainer({ ...BASE, ...STATS }).toJSON());
    expect(text).toMatch(/## 🎉 .* found!/);
    expect(text).not.toMatch(/## .*<@finder-1>/);
    expect(text).not.toMatch(/<@finder-1>.*Personal find/);
});

test("a count of 1 reads as 'First', and with no earlier find there's no 'Last one'", () => {
    const text = textOf(
        buildForwardContainer({
            ...BASE,
            finderDiscordId: "finder-1",
            findCount: 1,
            serverFindCount: 1,
            lastSeenInServerAt: null,
        }).toJSON(),
    );
    expect(text).toContain("**First** personal find · **First** in this server!");
    expect(text).not.toContain("Last one");
});

test("the card never uses pronouns about the finder", () => {
    // Not HELL: its spoofed name ("He200bll") trips the "he" check.
    for (const biome of ["WINDY", "GLITCHED"]) {
        // Skip the title line: the spoofed biome name ("He​ll") would false-match "he".
        const text = textOf(buildForwardContainer({ ...BASE, biome, ...STATS }).toJSON())
            .split("\n")
            .slice(1)
            .join("\n");
        expect(text).not.toMatch(/\b(their|they|his|her|he|she)\b/i);
    }
});

test("forwardMentions: only the role may ping; a dry run pings nobody", () => {
    expect(forwardMentions("role-1", false)).toEqual({ parse: [], roles: ["role-1"] });
    expect(forwardMentions("role-1", true)).toEqual({ parse: [], roles: [] });
    expect(forwardMentions(null, false)).toEqual({ parse: [], roles: [] });
});

test("the Network badge rides on a third flag - old two-flag ids still parse", () => {
    expect(forwardInfoCustomId({ network: true })).toBe(`${FORWARD_INFO_PREFIX}:0:0:1`);
    expect(forwardInfoCustomId({ delayed: true })).toBe(`${FORWARD_INFO_PREFIX}:1:0`);
    expect(parseForwardInfoParts(["0", "1", "1"])).toEqual({ delayed: false, simulated: true, network: true });
    expect(parseForwardInfoParts(["1", "0"])).toEqual({ delayed: true, simulated: false });
    expect(parseForwardInfoParts(["0", "0", "x"])).toBeNull();
    expect(forwardBadgeEmojis({ network: true, simulated: true })).toBe("🧪 🌐");

    const text = textOf(buildForwardInfoContainer({ network: true }).toJSON() as Json);
    expect(text).toContain("- `🌐 Network`\n> ");
});

test("flavor text: its own small -# line right under the title, only when given", () => {
    const withFlavor = textOf(buildForwardContainer({ ...BASE, flavorText: "Unexpected error occurred. [Code 404]" }).toJSON());
    expect(withFlavor).toContain("found!\n-# Unexpected error occurred. [Code 404]");
    expect(textOf(buildForwardContainer(BASE).toJSON())).not.toContain("Unexpected error");
});

test("every flavor text in BIOME_META is a non-empty single line", () => {
    const texts = Object.values(BIOME_META)
        .map((m) => m.flavorText)
        .filter((t): t is string => t !== undefined);
    expect(texts.length).toBeGreaterThan(0);
    for (const t of texts) {
        expect(t.trim()).toBe(t);
        expect(t).not.toContain("\n");
        expect(t.length).toBeGreaterThan(0);
    }
    expect(BIOME_META.GLITCHED.flavorText).toBe("Unexpected error occurred. [Code 404]");
    expect(BIOME_META.EGGLAND.flavorText).toBeUndefined();
});

test("the Home badge rides on a fourth flag, and older ids keep their shape", () => {
    expect(forwardInfoCustomId({ network: true, home: true })).toBe(`${FORWARD_INFO_PREFIX}:0:0:1:1`);
    expect(forwardInfoCustomId({ network: true })).toBe(`${FORWARD_INFO_PREFIX}:0:0:1`);
    expect(parseForwardInfoParts(["0", "0", "1", "1"])).toEqual({ delayed: false, simulated: false, network: true, home: true });
    expect(parseForwardInfoParts(["0", "0", "1", "x"])).toBeNull();
    expect(forwardBadgeEmojis({ network: true, home: true })).toBe("🌐 🏠");
    const text = textOf(buildForwardInfoContainer({ network: true, home: true }).toJSON() as Json);
    expect(text).toContain("- `🏠 Home`\n> ");
});

test("the counts and 'Last one' sit below a divider, apart from the title block (and its flavor text)", () => {
    const json = buildForwardContainer({
        ...BASE,
        flavorText: "Unexpected error occurred. [Code 404]",
        findCount: 3,
        serverFindCount: 41,
        lastSeenInServerAt: new Date(Date.now() - 86_400_000),
    }).toJSON() as Json;
    const top = json.components ?? [];
    const sectionText = textOf(top[0]);
    expect(sectionText).toContain("found!");
    expect(sectionText).toContain("Unexpected error occurred.");
    expect(sectionText).not.toContain("Personal find");
    expect(top[1].divider).toBe(true);
    expect(top[2].content).toContain("Personal find **#3**");
    expect(top[2].content).toContain("-# Last one");
});

test("no divider under the title when there's nothing extra to show", () => {
    const json = buildForwardContainer({ ...BASE, flavorText: "x" }).toJSON() as Json;
    expect(textOf(json)).not.toContain("Personal find");
    expect((json.components ?? [])[1]?.divider).not.toBe(true);
});
