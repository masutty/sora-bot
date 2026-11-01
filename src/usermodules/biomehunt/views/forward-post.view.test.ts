import { expect, test } from "bun:test";
import { ordinal } from "@/utils/format";
import { DEFAULT_BIOMES } from "../constants/biomes.constants";
import { VOTE_EMOJIS } from "../constants/vote-emojis.constants";
import { VoteStatus } from "../types";
import {
    buildForwardContainer,
    buildForwardInfoContainer,
    FORWARD_INFO_PREFIX,
    forwardBadgeLine,
    forwardInfoCustomId,
    forwardMentions,
    parseForwardInfoParts,
} from "./forward-post.view";

type Json = {
    type?: number;
    content?: string;
    spacing?: number;
    divider?: boolean;
    custom_id?: string;
    url?: string;
    label?: string;
    disabled?: boolean;
    emoji?: { id?: string; name?: string };
    components?: Json[];
};

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

/** The buttons of the card's one action row, in order. */
function buttonsOf(json: Json): Json[] {
    const row = flatten(json).find((c) => c.type === 1);
    return row?.components ?? [];
}

const BASE = { biome: "GLITCHED", roleId: null, serverLink: null, jumpLink: "https://discord.com/channels/g/c/m" };
const OPEN = { voteId: "abc12345", status: VoteStatus.OPEN, tally: { real: 2, fake: 0 } };

test("ordinal: 1st 2nd 3rd, the teens are 'th', and so are 111 and 112", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111, 112, 113].map(ordinal)).toEqual([
        "1st",
        "2nd",
        "3rd",
        "4th",
        "11th",
        "12th",
        "13th",
        "21st",
        "22nd",
        "23rd",
        "101st",
        "111th",
        "112th",
        "113th",
    ]);
});

test("the title block: title, flavor, then the role ping and the relative time on one line", () => {
    const text = textOf(
        buildForwardContainer({
            ...BASE,
            roleId: "role-1",
            sentAt: new Date(1_700_000_000_000),
            flavorText: "Unexpected error occurred. [Code 404]",
        }).toJSON(),
    );
    expect(text).toMatch(/^## 🎉 .* found!\n-# Unexpected error occurred\. \[Code 404\]\n<@&role-1> · <t:1700000000:R>/);
});

test("the ping line drops what it lacks: no role, no time, or neither", () => {
    expect(textOf(buildForwardContainer({ ...BASE, roleId: "role-1" }).toJSON())).toMatch(/found!\n<@&role-1>$/m);
    expect(textOf(buildForwardContainer({ ...BASE, sentAt: new Date(1_700_000_000_000) }).toJSON())).toContain("found!\n<t:1700000000:R>");
    expect(textOf(buildForwardContainer(BASE).toJSON())).not.toContain("·");
});

test("the card has no byline and no top-level role line: the first component is the title section", () => {
    const json = buildForwardContainer({ ...BASE, roleId: "role-1", finderDiscordId: "finder-1" }).toJSON() as Json;
    expect(json.components?.[0].type).toBe(9);
    expect(textOf(json)).not.toContain("-# Found by");
});

test("bullets: who found it, then both counts as ordinals; a count of 1 is '1st'", () => {
    const text = textOf(buildForwardContainer({ ...BASE, finderDiscordId: "finder-1", findCount: 3, serverFindCount: 41 }).toJSON());
    expect(text).toContain("- Found by <@finder-1>\n- **3rd** personal find, **41st** in this server");

    const first = textOf(buildForwardContainer({ ...BASE, finderDiscordId: "finder-1", findCount: 1, serverFindCount: 1 }).toJSON());
    expect(first).toContain("- **1st** personal find, **1st** in this server");
});

test("non-rare biome: plain title, never the 🎉 line", () => {
    const text = textOf(buildForwardContainer({ ...BASE, biome: "HELL" }).toJSON());
    expect(text).not.toContain("🎉");
    expect(text).toMatch(/^# /);
});

test("no 'Last one' line, even when the stat is passed", () => {
    const text = textOf(buildForwardContainer({ ...BASE, finderDiscordId: "f", lastSeenInServerAt: new Date() }).toJSON());
    expect(text).not.toContain("Last one");
});

test("the card never says 'their/they/he/she' about the finder", () => {
    // Not HELL: its spoofed name ("He200bll") trips the "he" check.
    for (const biome of ["WINDY", "GLITCHED"]) {
        const text = textOf(buildForwardContainer({ ...BASE, biome, finderDiscordId: "f", findCount: 3, serverFindCount: 41 }).toJSON())
            .split("\n")
            .slice(1)
            .join("\n");
        expect(text).not.toMatch(/\b(their|they|his|her|he|she)\b/i);
    }
});

test("no server link: the title is plain text and there's no Join Private Server button", () => {
    const json = buildForwardContainer(BASE).toJSON() as Json;
    expect(textOf(json)).not.toContain("(null)");
    expect(buttonsOf(json).map((b) => b.label)).toEqual(["Jump to Message"]);
});

test("the row: Join Private Server (📬) first, then Jump to Message, the votes and '?' - five buttons at most", () => {
    const json = buildForwardContainer({
        ...BASE,
        serverLink: "https://roblox.example/s",
        vote: OPEN,
        badges: { delayed: true },
    }).toJSON() as Json;
    const buttons = buttonsOf(json);
    expect(buttons.map((b) => b.label)).toEqual(["Join Private Server", "Jump to Message", "2", "0", "?"]);
    expect(buttons[0].emoji?.name).toBe("📬");
    expect(buttons[0].url).toBe("https://roblox.example/s");
    expect(buttons[1].url).toBe(BASE.jumpLink);
    expect(buttons.length).toBeLessThanOrEqual(5);
});

test("votes: the label is always the count - 0 stays '0' - with outlined icons while open", () => {
    const json = buildForwardContainer({ ...BASE, vote: { ...OPEN, tally: { real: 0, fake: 0 } } }).toJSON() as Json;
    const [real, fake] = buttonsOf(json).filter((b) => b.custom_id?.startsWith("biomehunt:vote:"));
    expect([real.label, fake.label]).toEqual(["0", "0"]);
    expect(real.custom_id).toBe("biomehunt:vote:abc12345:real");
    expect(fake.custom_id).toBe("biomehunt:vote:abc12345:fake");
    expect(real.emoji?.id).toBe(VOTE_EMOJIS.realOutline.id);
    expect(fake.emoji?.id).toBe(VOTE_EMOJIS.fakeOutline.id);
    expect(real.disabled).toBeFalsy();
    expect(textOf(json)).not.toContain("Is this biome real");
});

test("votes: a closed vote disables the buttons, the winner gets the filled icon, a tie fills both, no votes fills none", () => {
    const render = (status: VoteStatus, tally = { real: 3, fake: 1 }) =>
        buttonsOf(buildForwardContainer({ ...BASE, vote: { voteId: "abc12345", status, tally } }).toJSON() as Json).filter((b) =>
            b.custom_id?.startsWith("biomehunt:vote:"),
        );

    const [realWin, fakeLose] = render(VoteStatus.COMMUNITY_REAL);
    expect([realWin.emoji?.id, fakeLose.emoji?.id]).toEqual([VOTE_EMOJIS.realFilled.id, VOTE_EMOJIS.fakeOutline.id]);
    expect([realWin.disabled, fakeLose.disabled]).toEqual([true, true]);
    expect([realWin.label, fakeLose.label]).toEqual(["3", "1"]);

    const [realLose, fakeWin] = render(VoteStatus.ADMIN_DENIED);
    expect([realLose.emoji?.id, fakeWin.emoji?.id]).toEqual([VOTE_EMOJIS.realOutline.id, VOTE_EMOJIS.fakeFilled.id]);

    const [tieReal, tieFake] = render(VoteStatus.TIE, { real: 2, fake: 2 });
    expect([tieReal.emoji?.id, tieFake.emoji?.id]).toEqual([VOTE_EMOJIS.realFilled.id, VOTE_EMOJIS.fakeFilled.id]);

    const [noReal, noFake] = render(VoteStatus.NO_VOTES, { real: 0, fake: 0 });
    expect([noReal.emoji?.id, noFake.emoji?.id]).toEqual([VOTE_EMOJIS.realOutline.id, VOTE_EMOJIS.fakeOutline.id]);
    expect(noReal.disabled).toBe(true);
});

test("a closed vote adds one result bullet with our filled icon; an open vote adds none", () => {
    const textFor = (status: VoteStatus, decidedByUserId?: string) =>
        textOf(buildForwardContainer({ ...BASE, vote: { voteId: "v", status, tally: { real: 3, fake: 1 }, decidedByUserId } }).toJSON());
    const real = "<:check_filled:1566529778859909200>";
    expect(textFor(VoteStatus.COMMUNITY_REAL)).toContain(`- ${real} Marked as real by community voting`);
    expect(textFor(VoteStatus.ADMIN_CONFIRMED, "admin-1")).toContain(`- ${real} Marked as real by <@admin-1>`);
    expect(textFor(VoteStatus.ADMIN_DENIED, "admin-1")).toContain("- <:x_filled:1566529822665085139> Marked as fake by <@admin-1>");
    expect(textFor(VoteStatus.TIE)).toContain("- ⚖️ Tied vote");
    expect(textFor(VoteStatus.NO_VOTES)).toContain("- *Vote expired with no votes*");
    expect(textFor(VoteStatus.OPEN)).not.toContain("Marked as");
    expect(textFor(VoteStatus.COMMUNITY_REAL)).not.toContain("`✅");
});

test("a vote that check-vote can't resolve (a preview, a dry run) keeps its id out of '?'", () => {
    const json = buildForwardContainer({ ...BASE, vote: { ...OPEN, hideId: true } }).toJSON() as Json;
    expect(customIdsOf(json).some((id) => id.startsWith(FORWARD_INFO_PREFIX))).toBe(false);
});

test("'?' exists with a vote id or a badge, and its customId carries the vote id", () => {
    const withVote = buildForwardContainer({ ...BASE, vote: OPEN }).toJSON() as Json;
    expect(customIdsOf(withVote)).toContain(`${FORWARD_INFO_PREFIX}:0:0:0:0:abc12345`);
    const badgeOnly = buildForwardContainer({ ...BASE, badges: { delayed: true } }).toJSON() as Json;
    expect(customIdsOf(badgeOnly)).toContain(`${FORWARD_INFO_PREFIX}:1:0`);
    const neither = buildForwardContainer(BASE).toJSON() as Json;
    expect(customIdsOf(neither).some((id) => id.startsWith(FORWARD_INFO_PREFIX))).toBe(false);
});

test("badges: one quote line of chips under the bullets, none when there are no badges", () => {
    expect(forwardBadgeLine({ delayed: true, network: true })).toBe("> `⏳ Delayed` `🌐 Network`");
    expect(forwardBadgeLine({})).toBeNull();
    const text = textOf(buildForwardContainer({ ...BASE, finderDiscordId: "f", badges: { delayed: true } }).toJSON());
    expect(text).toContain("- Found by <@f>\n> `⏳ Delayed`");
    expect(textOf(buildForwardContainer(BASE).toJSON())).not.toContain("> `");
});

test("simulated: a banner on top with a divider under it, and the chip in the quote line", () => {
    const json = buildForwardContainer({ ...BASE, badges: { delayed: true, simulated: true } }).toJSON() as Json;
    const top = (json.components ?? []).slice(0, 2);
    expect(top[0].content).toBe("### 🧪 SIMULATED FORWARD - TESTING ONLY");
    expect(top[1].divider).toBe(true);
    expect(textOf(json)).toContain("> `⏳ Delayed` `🧪 Simulated`");
    expect(customIdsOf(json)).toContain(`${FORWARD_INFO_PREFIX}:1:1`);
});

test("layout: title section, a small divider, the bullets, a small divider, the button row - nothing else", () => {
    const json = buildForwardContainer({ ...BASE, finderDiscordId: "f", vote: OPEN }).toJSON() as Json;
    const types = (json.components ?? []).map((c) => (c.divider ? "divider" : c.type));
    expect(types).toEqual([9, "divider", 10, "divider", 1]);
    for (const sep of (json.components ?? []).filter((c) => c.divider)) expect(sep.spacing).toBe(1);
});

test("with nothing to list there is a single divider, above the buttons", () => {
    const json = buildForwardContainer(BASE).toJSON() as Json;
    const types = (json.components ?? []).map((c) => (c.divider ? "divider" : c.type));
    expect(types).toEqual([9, "divider", 1]);
});

test("forward info id round-trips, rejects malformed parts, and the explanation stays vague (no delay length)", () => {
    const badges = { delayed: true, simulated: true };
    const parts = forwardInfoCustomId(badges)
        .slice(FORWARD_INFO_PREFIX.length + 1)
        .split(":");
    expect(parseForwardInfoParts(parts)).toEqual({ badges, voteId: null });
    expect(parseForwardInfoParts(["x", "1"])).toBeNull();
    expect(parseForwardInfoParts([])).toBeNull();

    const text = textOf(buildForwardInfoContainer(badges).toJSON() as Json);
    expect(text).toContain("## Extra information");
    expect(text).toContain("- `⏳ Delayed`\n> This forward was sent with a delay.");
    expect(text).toContain("- `🧪 Simulated`\n> Not real");
    expect(text).not.toMatch(/\d+s\b|<t:/);
    expect(textOf(buildForwardInfoContainer({ delayed: true }).toJSON() as Json)).not.toContain("Simulated");
});

test("the vote id rides as a fifth part with all four flags; ids without it keep their old shape", () => {
    expect(forwardInfoCustomId({}, "abc12345")).toBe(`${FORWARD_INFO_PREFIX}:0:0:0:0:abc12345`);
    expect(forwardInfoCustomId({ network: true, home: true }, "k3m9x2ab")).toBe(`${FORWARD_INFO_PREFIX}:0:0:1:1:k3m9x2ab`);
    expect(parseForwardInfoParts(["0", "0", "1", "1", "k3m9x2ab"])).toEqual({
        badges: { delayed: false, simulated: false, network: true, home: true },
        voteId: "k3m9x2ab",
    });
    expect(parseForwardInfoParts(["0", "0", "0", "0", "bad id!"])).toBeNull();

    expect(forwardInfoCustomId({ network: true })).toBe(`${FORWARD_INFO_PREFIX}:0:0:1`);
    expect(forwardInfoCustomId({ delayed: true })).toBe(`${FORWARD_INFO_PREFIX}:1:0`);
    expect(parseForwardInfoParts(["0", "1", "1"])?.badges).toEqual({ delayed: false, simulated: true, network: true });
    expect(parseForwardInfoParts(["0", "0", "x"])).toBeNull();

    const text = textOf(buildForwardInfoContainer({ network: true, home: true }, "k3m9x2ab").toJSON() as Json);
    expect(text).toContain("- `Vote k3m9x2ab`");
    expect(text).toContain("- `🏠 Home`\n> ");
});

test("forwardMentions: only the role may ping; a dry run pings nobody", () => {
    expect(forwardMentions("role-1", false)).toEqual({ parse: [], roles: ["role-1"] });
    expect(forwardMentions("role-1", true)).toEqual({ parse: [], roles: [] });
    expect(forwardMentions(null, false)).toEqual({ parse: [], roles: [] });
});

test("every flavor text in DEFAULT_BIOMES is a non-empty single line", () => {
    const texts = Object.values(DEFAULT_BIOMES)
        .map((m) => m.flavorText)
        .filter((t): t is string => t !== undefined);
    expect(texts.length).toBeGreaterThan(0);
    for (const t of texts) {
        expect(t.trim()).toBe(t);
        expect(t).not.toContain("\n");
        expect(t.length).toBeGreaterThan(0);
    }
    expect(DEFAULT_BIOMES.GLITCHED.flavorText).toBe("Unexpected error occurred. [Code 404]");
    expect(DEFAULT_BIOMES.EGGLAND.flavorText).toBeUndefined();
});
