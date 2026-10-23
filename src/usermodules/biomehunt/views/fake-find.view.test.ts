import { expect, test } from "bun:test";
import { DEFAULT_BADGE_EMOJI } from "../constants/badges.constants";
import { getBiomeMeta } from "../constants/biomes.constants";
import { VoteStatus } from "../types";
import { buildFakeFindContainer, type FakeFindInput } from "./fake-find.view";

const BASE: FakeFindInput = {
    audience: "member",
    biome: "GLITCHED",
    finderDiscordId: "111",
    at: new Date("2026-01-01T00:00:00Z"),
    status: VoteStatus.ADMIN_DENIED,
    decidedBy: "999",
    tally: { real: 0, fake: 0 },
    seedsReverted: 120,
    xpReverted: 40,
    revokedBadge: "GLITCHED",
    forwardLink: "https://discord.com/channels/g/c/m",
};

const emoji = getBiomeMeta("GLITCHED")?.badgeEmoji || DEFAULT_BADGE_EMOJI;
const text = (input: Partial<FakeFindInput> = {}) =>
    (buildFakeFindContainer({ ...BASE, ...input }).toJSON().components as Array<{ content?: string }>).map((c) => c.content).join("\n");

test("member report for a deny lists removed, taken back and lost badge", () => {
    const out = text();
    expect(out).toContain("## ❌ Fake find");
    expect(out).toContain(`> ${emoji} **Glitched** · <t:1767225600:f>`);
    expect(out).toContain("> Denied by <@999>");
    expect(out).toContain("- Removed from your biomes");
    expect(out).toContain("- `120 🌱` `40 XP` taken back");
    expect(out).toContain(`- Lost the ${emoji} Glitched badge`);
    expect(out).toContain("-# fakefind · [Forward](https://discord.com/channels/g/c/m)");
});

test("community fake report says no rewards given", () => {
    const out = text({
        status: VoteStatus.COMMUNITY_FAKE,
        decidedBy: null,
        tally: { real: 1, fake: 3 },
        seedsReverted: 0,
        xpReverted: 0,
        revokedBadge: null,
    });
    expect(out).toContain("> Voted fake `✅ 1` `❌ 3`");
    expect(out).toContain("- No Seeds, XP or badge given");
    expect(out).not.toContain("taken back");
});

test("omits taken back when nothing was reverted", () => {
    const out = text({ seedsReverted: 0, xpReverted: 0, revokedBadge: null });
    expect(out).toContain("- Removed from your biomes");
    expect(out).not.toContain("taken back");
    expect(out).not.toContain("Lost the");
});

test("log report says their and names the finder", () => {
    const out = text({ audience: "log" });
    expect(out).toContain("**❌ Fake find**");
    expect(out).toContain("> <@111>");
    expect(out).toContain("- Removed from their biomes");
});
