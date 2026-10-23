import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import * as realConnection from "@/database/connection";

const sent: string[] = [];

mock.module("@/database/connection", () => ({
    ...realConnection,
    query: async (sql: string) => {
        sent.push(sql);
        return { rows: [], rowCount: 0 };
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
