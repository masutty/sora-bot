import { expect, test } from "bun:test";
import type { ContainerBuilder } from "discord.js";
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

const board = { servers: { real: 2, fake: 1 }, people: { real: 5, fake: 2 } };

test("formatScoreboard: servers first, people in parentheses", () => {
    expect(formatScoreboard(board)).toBe("✅ Real **2** servers (5) · ❌ Fake **1** server (2)");
});

test("buildMirrorContainer: an open vote shows the origin, both links and Real/Fake for this post", () => {
    const out = json(buildMirrorContainer({ post, roleId: "r1", vote: { status: "open" } }));
    expect(out).toContain("Sol Hunters");
    expect(out).toContain("<@&r1>");
    expect(out).toContain("biomehunt:net-vote:p1:real");
    expect(out).toContain("biomehunt:net-vote:p1:fake");
    expect(out).toContain("https://www.roblox.com/share?code=abc&type=Server");
    expect(out).toContain("https://discord.gg/solhunters");
});

test("buildMirrorContainer: a closed vote drops the buttons and shows the result with the scoreboard", () => {
    const out = json(buildMirrorContainer({ post, roleId: null, vote: { status: "fake", scoreboard: board } }));
    expect(out).not.toContain("net-vote");
    expect(out).toContain("The Network voted this fake");
    expect(out).toContain("Fake **1** server (2)");
});

test("buildMirrorContainer: inconclusive says not enough servers decided", () => {
    const out = json(buildMirrorContainer({ post, roleId: null, vote: { status: "inconclusive", scoreboard: board } }));
    expect(out).toContain("Not enough servers decided");
});

test("buildMirrorContainer: a simulated Mirror is marked, has no vote and no invite button when there is no invite", () => {
    const out = json(buildMirrorContainer({ post: { ...post, invite_url: null }, roleId: null, simulated: true }));
    expect(out).toContain("SIMULATED");
    expect(out).not.toContain("net-vote");
    expect(out).not.toContain("discord.gg");
});

test("serverNameLink: a clickable name when there is an invite, plain text otherwise, brackets can't break the link", () => {
    expect(serverNameLink("Sol Hunters", "https://discord.gg/sol")).toBe("[Sol Hunters](https://discord.gg/sol)");
    expect(serverNameLink("Sol Hunters", null)).toBe("**Sol Hunters**");
    expect(serverNameLink("[Sol] (Hunters)", "https://discord.gg/sol")).toBe("[Sol Hunters](https://discord.gg/sol)");
});

test("buildMirrorContainer: the origin's name links to its invite, and the Network badge has its ? button", () => {
    const out = json(buildMirrorContainer({ post, roleId: null, vote: { status: "open" } }));
    expect(out).toContain("[Sol Hunters](https://discord.gg/solhunters)");
    expect(out).toContain("🌐");
    expect(out).toContain("biomehunt:forward-info:0:0:1");
    expect(out).not.toContain("Join Sol Hunters");
});

test("buildMirrorContainer: a simulated Mirror carries both the test and the Network badges", () => {
    const out = json(buildMirrorContainer({ post, roleId: null, simulated: true }));
    expect(out).toContain("🧪 🌐");
    expect(out).toContain("biomehunt:forward-info:0:1:1");
});

test("buildMirrorContainer: the open vote is just the question, like the local forward card", () => {
    const out = json(buildMirrorContainer({ post, roleId: null, vote: { status: "open" } }));
    expect(out).toContain("**Is this biome real?**");
    expect(out).not.toContain("Vote below");
    expect(out).not.toContain("BiomeHunt");
});
