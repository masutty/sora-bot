import { expect, test } from "bun:test";
import { getAllBiomes, resetBiomeRegistry, setBiomeRegistry } from "../constants/biomes.constants";
import { type RareFind, VoteStatus } from "../types";
import { badgeEmojis, findsInSession, formatFindLine, forwardLink, macroLink } from "./rare-finds.service";

const find = (biome: string, over: Partial<RareFind> = {}, status?: VoteStatus): RareFind => ({
    eventId: 1,
    biome,
    at: new Date("2026-01-01T10:00:00Z"),
    macroMessageId: "111",
    macroChannelId: "222",
    vote: status ? { id: "v", status, decidedBy: null, channelId: "fc", messageId: "fm", jumpLink: "https://j/1", real: 1, fake: 0 } : null,
    ...over,
});

test("badgeEmojis groups repeats, orders by registry and skips fakes", () => {
    const finds = [find("SINGULARITY"), find("GLITCHED"), find("GLITCHED"), find("GLITCHED", {}, VoteStatus.COMMUNITY_FAKE)];
    expect(badgeEmojis(finds)).toBe("🔥🔥 🏅");
    expect(badgeEmojis([find("GLITCHED", {}, VoteStatus.ADMIN_DENIED)])).toBe("");
    expect(badgeEmojis([find("MYSTERY"), find("GLITCHED")])).toBe("🔥 🏅");
});

test("findsInSession includes both boundaries", () => {
    const s = { started_at: new Date("2026-01-01T10:00:00Z"), ended_at: new Date("2026-01-01T11:00:00Z") };
    const inside = [find("GLITCHED", { at: s.started_at }), find("GLITCHED", { at: s.ended_at })];
    const outside = [find("GLITCHED", { at: new Date("2026-01-01T11:00:01Z") })];
    expect(findsInSession([...inside, ...outside], s)).toEqual(inside);
});

test("macroLink and forwardLink", () => {
    expect(macroLink("g", find("GLITCHED"))).toBe("https://discord.com/channels/g/222/111");
    expect(macroLink("g", find("GLITCHED", { macroMessageId: "adm-5" }))).toBeNull();
    expect(macroLink("g", find("GLITCHED", { macroMessageId: null }))).toBeNull();
    expect(macroLink("g", find("GLITCHED", {}, VoteStatus.COMMUNITY_REAL))).toBe("https://j/1");
    expect(forwardLink("g", find("GLITCHED"))).toBeNull();
    expect(forwardLink("g", find("GLITCHED", {}, VoteStatus.COMMUNITY_REAL))).toBe("https://discord.com/channels/g/fc/fm");
});

test("formatFindLine joins time, biome, result and links", () => {
    const line = formatFindLine("g", find("GLITCHED", {}, VoteStatus.COMMUNITY_REAL));
    expect(line).toBe(
        "<t:1767261600:t> · 🔥 **Glitched** · ✅ Real\n-# [Macro message](https://j/1) · [Forward](https://discord.com/channels/g/fc/fm)",
    );
    expect(formatFindLine("g", find("GLITCHED", { macroMessageId: null }))).toBe("<t:1767261600:t> · 🔥 **Glitched**");
});

test("badgeEmojis plain mode swaps a custom emoji for the default", () => {
    setBiomeRegistry(getAllBiomes().map((b) => (b.key === "GLITCHED" ? { ...b, badgeEmoji: "<:glitch:123456>" } : b)));
    try {
        expect(badgeEmojis([find("GLITCHED")])).toBe("<:glitch:123456>");
        expect(badgeEmojis([find("GLITCHED")], true)).toBe("🏅");
    } finally {
        resetBiomeRegistry();
    }
});
