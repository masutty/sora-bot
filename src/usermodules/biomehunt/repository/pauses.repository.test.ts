import { expect, test } from "bun:test";
import { toPauseRow } from "./pauses.repository";

const base = {
    id: "7" as unknown as number,
    user_id: "3" as unknown as number,
    kind: "forced" as const,
    message: null,
    by_discord_id: null,
    counts: true,
    notify: "now" as const,
    notice_sent_at: null,
    dismissable: true,
    notice_channel_id: null,
    notice_message_id: null,
    reminder_sent_at: null,
    started_at: new Date(),
    ended_at: null,
    ended_reason: null,
};

test("toPauseRow folds until_kind/until_at into until and converts ids", () => {
    const at = new Date("2026-11-03T00:00:00Z");
    expect(toPauseRow({ ...base, until_kind: "time", until_at: at })).toMatchObject({ id: 7, user_id: 3, until: { kind: "time", at } });
    expect(toPauseRow({ ...base, until_kind: "session_end", until_at: null }).until).toEqual({ kind: "session_end" });
    expect(toPauseRow({ ...base, until_kind: "interaction", until_at: null }).until).toEqual({ kind: "interaction" });
});

test("toPauseRow throws on a timed pause without until_at", () => {
    expect(() => toPauseRow({ ...base, until_kind: "time", until_at: null })).toThrow(/until_at/);
});
