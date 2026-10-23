import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import * as realConnection from "@/database/connection";

const sent: string[] = [];
let nextRows: unknown[] = [];

mock.module("@/database/connection", () => ({
    ...realConnection,
    query: async (sql: string) => {
        sent.push(sql);
        return { rows: nextRows, rowCount: nextRows.length };
    },
}));

import type * as Repo from "./activity.repository";

let repo: typeof Repo;
beforeAll(async () => {
    repo = await import("./activity.repository");
});

afterAll(() => mock.module("@/database/connection", () => realConnection));
beforeEach(() => {
    sent.length = 0;
    nextRows = [];
});

test("every count query excludes fake finds", async () => {
    const calls: Array<() => Promise<unknown>> = [
        () => repo.getBiomeCounts(1),
        () => repo.getBiomeCountsInRange(1, new Date(), new Date()),
        () => repo.getBiomeCountForUser(1, "GLITCHED"),
        () => repo.getGuildBiomeCounts("g"),
        () => repo.getBiomeTopContributors("g"),
        () => repo.getGuildBiomeFindStats("g", "GLITCHED", null),
    ];
    for (const call of calls) {
        sent.length = 0;
        await call();
        expect(sent).toHaveLength(1);
        expect(sent[0]).toContain(repo.NOT_FAKE_SQL);
    }
});

test("getRareFinds includes denied votes whose event is gone", async () => {
    const created = new Date("2026-01-01T10:00:00Z");
    nextRows = [
        {
            event_id: null,
            biome: "GLITCHED",
            at: created,
            macro_message_id: null,
            macro_channel_id: null,
            vote_id: "abc",
            status: "admin_denied",
            decided_by: "9",
            vote_channel_id: "c1",
            vote_message_id: "m1",
            jump_link: "https://discord.com/channels/g/c/x",
            real: "1",
            fake: "2",
        },
    ];
    const finds = await repo.getRareFinds(1, ["GLITCHED"]);
    expect(sent[0]).toContain("event_id IS NULL");
    expect(sent[0]).not.toContain(repo.NOT_FAKE_SQL);
    expect(finds).toHaveLength(1);
    expect(finds[0]?.eventId).toBeNull();
    expect(finds[0]?.at).toBe(created);
    expect(finds[0]?.vote).toMatchObject({ id: "abc", status: "admin_denied", real: 1, fake: 2 });
});
