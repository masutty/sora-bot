import { expect, test } from "bun:test";
import { buildBalanceReply } from "./balance.view";

const text = (reply: ReturnType<typeof buildBalanceReply>) => JSON.stringify(reply.components);

test("own balance shows Seeds and level progress", () => {
    const reply = buildBalanceReply("111", true, { seeds: 120, xp: 60 });
    expect(text(reply)).toContain("Your balance");
    expect(text(reply)).toContain("🌱 Seeds: 120");
    expect(text(reply)).toContain("Level 2 (10/150 XP)");
});

test("someone else's balance names them and never pings", () => {
    const reply = buildBalanceReply("222", false, { seeds: 0, xp: 0 });
    expect(text(reply)).toContain("<@222>'s balance");
    expect(reply.allowedMentions).toEqual({ parse: [] });
});

test("no profile: self gets the setup hint, others a plain note", () => {
    expect(text(buildBalanceReply("111", true, null))).toContain("Run `/bh setup` to get started.");
    expect(text(buildBalanceReply("222", false, null))).toContain("<@222> doesn't have a profile yet.");
});
