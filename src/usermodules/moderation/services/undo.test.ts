import { expect, test } from "bun:test";
import { ButtonStyle } from "discord.js";
import type { CaseKind, CaseRow } from "../types";
import { caseChannelPayload } from "./payloads";
import { parseUndoParts, undoCustomId, undoRow } from "./undo";
import { createUndoTracker } from "./undo-tracker";

const row = (kind: CaseKind): CaseRow => ({
    id: "AB12",
    guild_id: "g",
    kind,
    user_id: "u",
    moderator_id: "m",
    reason: "r",
    weight: 1,
    role_id: kind === "temprole" ? "r1" : null,
    created_at: new Date("2026-01-01T00:00:00Z"),
    expires_at: null,
    ended_at: null,
    end_reason: null,
    ended_by: null,
    end_note: null,
    triggered_by: null,
    threshold_level: null,
    dm_delivered: null,
    dm_error: null,
});

test("only warn, mute, ban and temprole get a danger button, on the Created post", () => {
    const labels: Record<string, string | undefined> = {};
    for (const kind of ["warn", "mute", "kick", "ban", "softban", "temprole"] as const) {
        labels[kind] = (undoRow(row(kind), 1)?.toJSON().components[0] as { label?: string } | undefined)?.label;
    }
    expect(labels).toEqual({ warn: "Revoke", mute: "Unmute", kick: undefined, ban: "Unban", softban: undefined, temprole: "Remove role" });
    expect(undoRow(row("warn"), 1)?.toJSON().components[0]).toMatchObject({ style: ButtonStyle.Danger });
    expect(caseChannelPayload({ event: "created", case: row("warn"), by: "m" }).components).toHaveLength(2);
    expect(caseChannelPayload({ event: "revoked", case: row("warn"), by: "m" }).components).toHaveLength(1);
    expect(caseChannelPayload({ event: "created", case: row("kick"), by: "m" }).components).toHaveLength(1);
});

test("the customId round-trips", () => {
    const id = undoCustomId("AB12", 1767225600);
    expect(id).toBe("moderation:undo:AB12:1767225600");
    expect(parseUndoParts(id.slice("moderation:undo:".length).split(":"))).toEqual({ caseId: "AB12", postedAt: 1767225600 });
    expect(parseUndoParts(["AB12", "x"])).toBeNull();
});

test("the tracker strips a post on release and on timeout, once", async () => {
    const stripped: string[] = [];
    const tracker = createUndoTracker(async (ref) => void stripped.push(ref.messageId), 10);
    tracker.remember("a", { channelId: "c", messageId: "m1" });
    await tracker.release("a");
    await tracker.release("a");
    tracker.remember("b", { channelId: "c", messageId: "m2" });
    await new Promise((r) => setTimeout(r, 30));
    expect(stripped).toEqual(["m1", "m2"]);
    expect(tracker.has("b")).toBe(false);
});
