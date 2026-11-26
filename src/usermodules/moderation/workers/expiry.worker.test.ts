import { describe, expect, test } from "bun:test";
import { makeHarness } from "../services/case.service.test";
import type { CaseRow } from "../types";
import { createExpiryTick, EXPIRY_BATCH, expiryWorker } from "./expiry.worker";

const NOW = new Date("2026-02-01T00:00:00Z");
const base = { guildId: "g1", userId: "u1", moderatorId: "mod1" };

describe("expiry tick", () => {
    test("an overdue temp ban is unbanned once, even across two ticks", async () => {
        const h = makeHarness();
        await h.service.ban({ ...base, durationS: 60 });
        h.advance(3600_000);
        const tick = createExpiryTick({
            now: () => NOW,
            dueCases: async () => h.cases.filter((c) => !c.ended_at && c.expires_at && c.expires_at <= NOW),
            expire: (row) => h.service.expire(row),
        });
        h.calls.length = 0;
        await tick();
        await tick();
        expect(h.calls.filter((c) => c === "unban")).toHaveLength(1);
        expect(h.cases[0]?.end_reason).toBe("expired");
    });

    test("an already unbanned user is just recorded", async () => {
        const h = makeHarness();
        await h.service.ban({ ...base, durationS: 60 });
        h.deps.discord.unban = async () => {
            throw Object.assign(new Error("Unknown Ban"), { code: 10026 });
        };
        const tick = createExpiryTick({ now: () => NOW, dueCases: async () => [...h.cases], expire: (row) => h.service.expire(row) });
        await tick();
        expect(h.cases[0]?.end_reason).toBe("expired");
    });

    test("a failing case does not stop the others, and the batch size is 50", async () => {
        const rows = [{ id: "A" }, { id: "B" }, { id: "C" }] as CaseRow[];
        const done: string[] = [];
        let limit = 0;
        const tick = createExpiryTick({
            now: () => NOW,
            dueCases: async (_now, l) => {
                limit = l;
                return rows;
            },
            expire: async (row) => {
                if (row.id === "B") throw new Error("boom");
                done.push(row.id);
            },
        });
        await tick();
        expect(done).toEqual(["A", "C"]);
        expect(limit).toBe(EXPIRY_BATCH);
    });

    test("the worker definition runs every minute and on start", () => {
        const worker = expiryWorker(() => {
            throw new Error("unused");
        });
        expect(worker).toMatchObject({ name: "expiry", intervalMs: 60_000, runOnStart: true });
    });
});
