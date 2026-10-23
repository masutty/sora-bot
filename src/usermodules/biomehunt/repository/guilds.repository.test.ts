import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import * as realConnection from "@/database/connection";

let categoryRows: unknown[] = [];
const sqls: string[] = [];

mock.module("@/database/connection", () => ({
    ...realConnection,
    query: async (sql: string) => {
        sqls.push(sql);
        if (sql.includes("bh_guild_categories")) return { rows: categoryRows, rowCount: categoryRows.length };
        if (sql.includes("bh_guild_roles")) {
            return { rows: [{ active_role_id: null, idle_role_id: null, inactive_role_id: null }], rowCount: 1 };
        }
        return { rows: [{ guild_id: "g" }], rowCount: 1 };
    },
}));

import type * as Repo from "./guilds.repository";

let repo: typeof Repo;
beforeAll(async () => {
    repo = await import("./guilds.repository");
});

afterAll(() => mock.module("@/database/connection", () => realConnection));
beforeEach(() => repo.invalidateGuildConfigCache("g"));

test("isGuildReady: a category with no status roles is ready", async () => {
    categoryRows = [{ discord_category_id: "c1" }];
    expect(await repo.isGuildReady("g")).toEqual({ ready: true, hasCategory: true });
});

test("resetGuildConfig clears the log channel", async () => {
    sqls.length = 0;
    await repo.resetGuildConfig("g");
    expect(sqls.some((s) => s.includes("UPDATE bh_guilds") && s.includes("log_channel_id = NULL"))).toBe(true);
});

test("isGuildReady: no category is not ready", async () => {
    categoryRows = [];
    expect(await repo.isGuildReady("g")).toEqual({ ready: false, hasCategory: false });
});
