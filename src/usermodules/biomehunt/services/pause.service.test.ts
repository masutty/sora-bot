import { describe, expect, test } from "bun:test";
import type { PauseRow, PauseUntil } from "../repository/pauses.repository";
import { BiomeHuntError, type UserRow } from "../types";
import {
    endPauseFromMember,
    expireDueTimedPauses,
    forcePause,
    onSessionEnded,
    type PauseDeps,
    resolveUntil,
    unpauseByAdmin,
} from "./pause.service";

const NOW = new Date("2026-11-03T12:00:00Z");

function pauseRow(over: Partial<PauseRow> = {}): PauseRow {
    return {
        id: 7,
        user_id: 1,
        kind: "forced",
        message: "hi",
        by_discord_id: "admin",
        counts: true,
        notify: "session_end",
        until: { kind: "interaction" },
        notice_sent_at: null,
        started_at: NOW,
        ended_at: null,
        ended_reason: null,
        ...over,
    };
}

interface Calls {
    sent: number[];
    created: Parameters<PauseDeps["createPause"]>[0][];
    ended: { id: number; reason: string }[];
    noticeMarked: number[];
    uncounted: number[];
}

function makeDeps(
    opts: { status?: string; user?: boolean; channel?: boolean; active?: PauseRow | null; due?: PauseRow[]; noticeOk?: boolean } = {},
) {
    const calls: Calls = { sent: [], created: [], ended: [], noticeMarked: [], uncounted: [] };
    const deps: PauseDeps = {
        getUserByDiscordId: async () => (opts.user === false ? null : ({ id: 1, current_status: opts.status ?? "active" } as UserRow)),
        hasMacroChannel: async () => opts.channel !== false,
        createPause: async (input) => {
            calls.created.push(input);
            return pauseRow({ ...input, user_id: input.userId, by_discord_id: input.byDiscordId });
        },
        endActivePause: async (_userId, reason) => {
            if (!opts.active) return null;
            calls.ended.push({ id: opts.active.id, reason });
            return opts.active;
        },
        endPauseById: async (id, reason) => {
            calls.ended.push({ id, reason });
            return pauseRow({ id });
        },
        getActivePause: async () => opts.active ?? null,
        getPauseById: async () => opts.active ?? null,
        getUserById: async () => ({ id: 1, discord_user_id: "member" }) as UserRow,
        markNoticeSent: async (id) => {
            calls.noticeMarked.push(id);
        },
        getDueTimedPauses: async () => opts.due ?? [],
        markCurrentSessionUncounted: async (userId) => {
            calls.uncounted.push(userId);
        },
        sendNotice: async (pause) => {
            calls.sent.push(pause.id);
            return opts.noticeOk ?? true;
        },
        now: () => NOW,
    };
    return { deps, calls };
}

const baseInput = {
    guildId: "g",
    discordUserId: "member",
    message: "hi",
    count: true,
    notify: "session_end" as const,
    until: { kind: "interaction" } as const,
    byDiscordId: "admin",
};

describe("resolveUntil", () => {
    test("time gives now + duration", () => {
        const u = resolveUntil({ kind: "time", duration: "3d" }, false, NOW) as Extract<PauseUntil, { kind: "time" }>;
        expect(u.at.getTime()).toBe(NOW.getTime() + 3 * 86400_000);
    });
    test.each(["0d", "abc", "-1h", ""])("rejects %p", (d) => {
        expect(() => resolveUntil({ kind: "time", duration: d }, true, NOW)).toThrow(BiomeHuntError);
    });
    test("session_end needs an active member", () => {
        expect(() => resolveUntil({ kind: "session_end" }, false, NOW)).toThrow(BiomeHuntError);
        expect(resolveUntil({ kind: "session_end" }, true, NOW)).toEqual({ kind: "session_end" });
    });
    test("interaction passes", () => {
        expect(resolveUntil({ kind: "interaction" }, false, NOW)).toEqual({ kind: "interaction" });
    });
});

describe("forcePause", () => {
    test("notify now sends once and marks the notice", async () => {
        const { deps, calls } = makeDeps();
        await forcePause(deps, { ...baseInput, notify: "now" });
        expect(calls.sent).toEqual([7]);
        expect(calls.noticeMarked).toEqual([7]);
    });
    test("notify session_end with an active member sends nothing", async () => {
        const { deps, calls } = makeDeps({ status: "active" });
        await forcePause(deps, baseInput);
        expect(calls.sent).toEqual([]);
    });
    test("notify session_end with an inactive member sends immediately", async () => {
        const { deps, calls } = makeDeps({ status: "inactive" });
        await forcePause(deps, baseInput);
        expect(calls.sent).toEqual([7]);
    });
    test("count false marks the session uncounted", async () => {
        const { deps, calls } = makeDeps();
        await forcePause(deps, { ...baseInput, count: false });
        expect(calls.uncounted).toEqual([1]);
        const yes = makeDeps();
        await forcePause(yes.deps, baseInput);
        expect(yes.calls.uncounted).toEqual([]);
    });
    test("delegates to createPause", async () => {
        const { deps, calls } = makeDeps();
        await forcePause(deps, baseInput);
        expect(calls.created).toHaveLength(1);
        expect(calls.created[0]).toMatchObject({ userId: 1, kind: "forced", counts: true, byDiscordId: "admin" });
    });
    test("refuses a member with no row or no channel", async () => {
        await expect(forcePause(makeDeps({ user: false }).deps, baseInput)).rejects.toThrow(BiomeHuntError);
        await expect(forcePause(makeDeps({ channel: false }).deps, baseInput)).rejects.toThrow(BiomeHuntError);
    });
    test("a failing Notice does not throw", async () => {
        const { deps, calls } = makeDeps({ noticeOk: false });
        const reply = await forcePause(deps, { ...baseInput, notify: "now" });
        expect(reply).toContain("Notice could not be sent");
        expect(calls.created).toHaveLength(1);
    });
    test("a throwing Notice does not throw", async () => {
        const { deps } = makeDeps();
        deps.sendNotice = async () => {
            throw new Error("boom");
        };
        const reply = await forcePause(deps, { ...baseInput, notify: "now" });
        expect(reply).toContain("Notice could not be sent");
    });
});

describe("onSessionEnded", () => {
    test("sends the Notice, then ends a session_end pause", async () => {
        const order: string[] = [];
        const { deps } = makeDeps({ active: pauseRow({ until: { kind: "session_end" } }) });
        deps.sendNotice = async () => {
            order.push("notice");
            return true;
        };
        deps.endPauseById = async () => {
            order.push("end");
            return null;
        };
        await onSessionEnded(deps, 1);
        expect(order).toEqual(["notice", "end"]);
    });
    test("no second Notice when already sent", async () => {
        const { deps, calls } = makeDeps({ active: pauseRow({ notice_sent_at: NOW, until: { kind: "session_end" } }) });
        await onSessionEnded(deps, 1);
        expect(calls.sent).toEqual([]);
        expect(calls.ended).toEqual([{ id: 7, reason: "session_end" }]);
    });
    test("pause stays for interaction", async () => {
        const { deps, calls } = makeDeps({ active: pauseRow() });
        await onSessionEnded(deps, 1);
        expect(calls.sent).toEqual([7]);
        expect(calls.ended).toEqual([]);
    });
    test("no pause is a no-op", async () => {
        const { deps, calls } = makeDeps({ active: null });
        await onSessionEnded(deps, 1);
        expect(calls.sent).toEqual([]);
    });
});

describe("expireDueTimedPauses", () => {
    test("ends each due pause as expired", async () => {
        const { deps, calls } = makeDeps({ due: [pauseRow({ id: 1 }), pauseRow({ id: 2 })] });
        await expireDueTimedPauses(deps, NOW);
        expect(calls.ended).toEqual([
            { id: 1, reason: "expired" },
            { id: 2, reason: "expired" },
        ]);
    });
    test("a failing pause does not stop the sweep", async () => {
        const { deps, calls } = makeDeps({ due: [pauseRow({ id: 1 }), pauseRow({ id: 2 })] });
        const real = deps.endPauseById;
        deps.endPauseById = async (id, reason) => {
            if (id === 1) throw new Error("boom");
            return real(id, reason);
        };
        await expireDueTimedPauses(deps, NOW);
        expect(calls.ended).toEqual([{ id: 2, reason: "expired" }]);
    });
});

describe("endPauseFromMember", () => {
    test("ended for the owner", async () => {
        const { deps, calls } = makeDeps({ active: pauseRow() });
        expect(await endPauseFromMember(7, "member", deps)).toBe("ended");
        expect(calls.ended).toEqual([{ id: 7, reason: "member" }]);
    });
    test("not_owner for someone else", async () => {
        const { deps } = makeDeps({ active: pauseRow() });
        expect(await endPauseFromMember(7, "other", deps)).toBe("not_owner");
    });
    test("not_active when missing or already ended", async () => {
        expect(await endPauseFromMember(7, "member", makeDeps({ active: null }).deps)).toBe("not_active");
        expect(await endPauseFromMember(7, "member", makeDeps({ active: pauseRow({ ended_at: NOW }) }).deps)).toBe("not_active");
    });
});

describe("unpauseByAdmin", () => {
    test("ends the pause with reason admin", async () => {
        const { deps, calls } = makeDeps({ active: pauseRow() });
        await unpauseByAdmin("g", "member", deps);
        expect(calls.ended).toEqual([{ id: 7, reason: "admin" }]);
    });
    test("throws when not paused", async () => {
        await expect(unpauseByAdmin("g", "member", makeDeps({ active: null }).deps)).rejects.toThrow(BiomeHuntError);
    });
});
