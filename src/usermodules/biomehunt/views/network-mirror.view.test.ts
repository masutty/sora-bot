import { expect, test } from "bun:test";
import type { ContainerBuilder } from "discord.js";
import { VOTE_EMOJIS } from "../constants/vote-emojis.constants";
import { buildMirrorContainer, formatScoreboard, type MirrorPost, serverNameLink } from "./network-mirror.view";

const json = (c: ContainerBuilder) => JSON.stringify(c.toJSON());

const post: MirrorPost = {
    id: "p1",
    biome: "GLITCHED",
    origin_name: "Sol Hunters",
    origin_icon_url: "https://cdn.discordapp.com/icons/1/a.png",
    invite_url: "https://discord.gg/solhunters",
    server_link: "https://www.roblox.com/share?code=abc&type=Server",
};

const board = { real: 5, fake: 2 };

test("formatScoreboard: one count per side, in people", () => {
    expect(formatScoreboard(board)).toBe("✅ Real **5** · ❌ Fake **2**");
});

/** Every text display's content in the container, joined by newlines. */
function textsOf(c: ContainerBuilder): string {
    const out: string[] = [];
    const walk = (node: { content?: string; components?: unknown[] }) => {
        if (node.content) out.push(node.content);
        for (const child of node.components ?? []) walk(child as { content?: string; components?: unknown[] });
    };
    walk(c.toJSON() as { components?: unknown[] });
    return out.join("\n");
}

type Btn = { label?: string; custom_id?: string; url?: string; disabled?: boolean; emoji?: { id?: string; name?: string } };

/** The buttons of the Mirror's one action row, in order. */
function buttonsOf(c: ContainerBuilder): Btn[] {
    const row = (c.toJSON().components as Array<{ type: number; components?: Btn[] }>).find((x) => x.type === 1);
    return row?.components ?? [];
}

test("an open vote: both links, the live votes and '?' share one row - no byline, no question", () => {
    const c = buildMirrorContainer({ post, roleId: "r1", vote: { status: "open", scoreboard: { real: 3, fake: 0 } } });
    const buttons = buttonsOf(c);
    expect(buttons.map((b) => b.label)).toEqual(["Join Private Server", "Join Discord", "3", "0", "?"]);
    expect(buttons[0].emoji?.name).toBe("📬");
    expect(buttons[0].url).toBe("https://www.roblox.com/share?code=abc&type=Server");
    expect(buttons[1].url).toBe("https://discord.gg/solhunters");
    expect(buttons[2].custom_id).toBe("biomehunt:net-vote:p1:real");
    expect(buttons[3].custom_id).toBe("biomehunt:net-vote:p1:fake");
    expect(buttons[2].emoji?.id).toBe(VOTE_EMOJIS.realOutline.id);
    expect(buttons[4].custom_id).toBe("biomehunt:forward-info:0:0:1:0:p1");
    const text = textsOf(c);
    expect(text).toContain("<@&r1>");
    expect(text).not.toContain("Is this biome real");
    expect(text).not.toContain("-# From");
});

test("the votes show 0 as '0' when nobody voted yet", () => {
    const buttons = buttonsOf(buildMirrorContainer({ post, roleId: null, vote: { status: "open" } }));
    expect([buttons[2].label, buttons[3].label]).toEqual(["0", "0"]);
});

test("a closed vote disables the buttons and fills the winner's icon; a tie fills both; no ballots fills none", () => {
    const real = buttonsOf(buildMirrorContainer({ post, roleId: null, vote: { status: "real", scoreboard: board } }));
    expect([real[2].emoji?.id, real[3].emoji?.id]).toEqual([VOTE_EMOJIS.realFilled.id, VOTE_EMOJIS.fakeOutline.id]);
    expect([real[2].disabled, real[3].disabled]).toEqual([true, true]);
    expect([real[2].label, real[3].label]).toEqual(["5", "2"]);

    const fake = buttonsOf(buildMirrorContainer({ post, roleId: null, vote: { status: "fake", scoreboard: board } }));
    expect([fake[2].emoji?.id, fake[3].emoji?.id]).toEqual([VOTE_EMOJIS.realOutline.id, VOTE_EMOJIS.fakeFilled.id]);

    const tie = buttonsOf(buildMirrorContainer({ post, roleId: null, vote: { status: "inconclusive", scoreboard: { real: 2, fake: 2 } } }));
    expect([tie[2].emoji?.id, tie[3].emoji?.id]).toEqual([VOTE_EMOJIS.realFilled.id, VOTE_EMOJIS.fakeFilled.id]);

    const none = buttonsOf(
        buildMirrorContainer({ post, roleId: null, vote: { status: "inconclusive", scoreboard: { real: 0, fake: 0 } } }),
    );
    expect([none[2].emoji?.id, none[3].emoji?.id]).toEqual([VOTE_EMOJIS.realOutline.id, VOTE_EMOJIS.fakeOutline.id]);
});

test("a closed vote adds one result bullet: the Network, the bot owner, a tie, or nobody voting", () => {
    const textFor = (vote: Parameters<typeof buildMirrorContainer>[0]["vote"]) =>
        textsOf(buildMirrorContainer({ post, roleId: null, vote }));
    expect(textFor({ status: "real", scoreboard: board })).toContain("- <:check_filled:1566529778859909200> Marked as real by the Network");
    expect(textFor({ status: "fake", scoreboard: board, decidedBy: "owner" })).toContain(
        "- <:x_filled:1566529822665085139> Marked as fake by <@owner>",
    );
    expect(textFor({ status: "inconclusive", scoreboard: { real: 2, fake: 2 } })).toContain("- ⚖️ Tied vote");
    expect(textFor({ status: "inconclusive", scoreboard: { real: 0, fake: 0 } })).toContain("- *Vote expired with no votes*");
    expect(textFor({ status: "open", scoreboard: board })).not.toContain("Marked as");
});

test("the origin is the first bullet: its name cut to 18 characters and linked to its invite", () => {
    const text = textsOf(buildMirrorContainer({ post, roleId: null, vote: { status: "open" } }));
    expect(text).toContain("- From [Sol Hunters](https://discord.gg/solhunters)\n> `🌐 Network`");

    const long = textsOf(
        buildMirrorContainer({ post: { ...post, origin_name: "The Official Community Hub of the Very Long Named Server" }, roleId: null }),
    );
    expect(long).toContain("- From [The Official Comm…](https://discord.gg/solhunters)");
    expect(long).not.toContain("Very Long");
});

test("a simulated Mirror is marked, has no votes and no Join Discord button when there is no invite", () => {
    const c = buildMirrorContainer({ post: { ...post, invite_url: null }, roleId: null, simulated: true });
    const out = json(c);
    expect(out).toContain("SIMULATED");
    expect(out).not.toContain("net-vote");
    expect(out).not.toContain("discord.gg");
    expect(textsOf(c)).toContain("> `🧪 Simulated` `🌐 Network`");
    expect(buttonsOf(c).map((b) => b.label)).toEqual(["Join Private Server", "?"]);
    expect(buttonsOf(c)[1].custom_id).toBe("biomehunt:forward-info:0:1:1");
});

test("a home Mirror (the origin's own find) carries the Home badge and never pings", () => {
    const c = buildMirrorContainer({ post, roleId: "r1", home: true, vote: { status: "open" } });
    expect(textsOf(c)).toContain("> `🌐 Network` `🏠 Home`");
    expect(textsOf(c)).not.toContain("<@&r1>");
    expect(buttonsOf(c).at(-1)?.custom_id).toBe("biomehunt:forward-info:0:0:1:1:p1");
});

test("without an invite the origin is bold text and there is no Join Discord button", () => {
    const c = buildMirrorContainer({ post: { ...post, invite_url: null }, roleId: null, vote: { status: "open" } });
    expect(textsOf(c)).toContain("- From **Sol Hunters**");
    expect(buttonsOf(c).map((b) => b.label)).not.toContain("Join Discord");
});

test("serverNameLink: a clickable name when there is an invite, plain text otherwise, brackets can't break the link, long names are cut", () => {
    expect(serverNameLink("Sol Hunters", "https://discord.gg/sol")).toBe("[Sol Hunters](https://discord.gg/sol)");
    expect(serverNameLink("Sol Hunters", null)).toBe("**Sol Hunters**");
    expect(serverNameLink("[Sol] (Hunters)", "https://discord.gg/sol")).toBe("[Sol Hunters](https://discord.gg/sol)");
    expect(serverNameLink("Sol Hunters Unlimited Edition", null, 12)).toBe("**Sol Hunters…**");
});

test("the biome's flavor text sits on its own -# line under the title, markdown escaped, the ping after it", () => {
    const text = textsOf(
        buildMirrorContainer({ post: { ...post, biome: "CYBERSPACE" }, roleId: "r1", flavorText: "Signal_Received | From: Island_SOL" }),
    );
    expect(text).toContain("found!\n-# Signal\\_Received \\| From: Island\\_SOL\n<@&r1>");
    expect(textsOf(buildMirrorContainer({ post, roleId: null }))).not.toContain("Signal");
});
