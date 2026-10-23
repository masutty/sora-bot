import { expect, test } from "bun:test";
import { type RareFind, VoteStatus } from "../types";
import { findResultLabel } from "./vote-outcome";

const vote = (status: VoteStatus, extra: Partial<NonNullable<RareFind["vote"]>> = {}): RareFind["vote"] => ({
    id: "v",
    status,
    decidedBy: "42",
    channelId: "c",
    messageId: "m",
    jumpLink: "l",
    real: 3,
    fake: 5,
    ...extra,
});

test("findResultLabel words every status", () => {
    expect(findResultLabel(null)).toBe("");
    expect(findResultLabel(vote(VoteStatus.COMMUNITY_REAL))).toBe("✅ Real");
    expect(findResultLabel(vote(VoteStatus.ADMIN_CONFIRMED))).toBe("✅ Confirmed by <@42>");
    expect(findResultLabel(vote(VoteStatus.COMMUNITY_FAKE))).toBe("❌ Fake `✅ 3` `❌ 5`");
    expect(findResultLabel(vote(VoteStatus.ADMIN_DENIED))).toBe("❌ Denied by <@42>");
    expect(findResultLabel(vote(VoteStatus.TIE))).toBe("⚖️ Tied");
    expect(findResultLabel(vote(VoteStatus.OPEN))).toBe("⏳ Voting");
    expect(findResultLabel(vote(VoteStatus.NO_VOTES))).toBe("No votes");
});
