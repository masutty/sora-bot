import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import * as connection from "@/database/connection";
import * as repo from "./shop.repository";

const calls: Array<{ sql: string; params: unknown[] }> = [];
let rows: unknown[] = [];

const run = async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    return { rows, rowCount: rows.length };
};

/* Spies, not mock.module: bun shares one module registry across test files, so a second mock.module of the connection is ignored. */
const spies: Array<{ mockRestore: () => void }> = [];
beforeAll(() => {
    spies.push(spyOn(connection, "query").mockImplementation(run as never));
    spies.push(
        spyOn(connection, "transaction").mockImplementation((async (fn: (client: { query: typeof run }) => Promise<unknown>) =>
            fn({ query: run })) as never),
    );
});
afterAll(() => {
    for (const spy of spies) spy.mockRestore();
});

test("ensureShop creates the row once", async () => {
    calls.length = 0;
    rows = [{ guild_id: "1", open: false, sales_channel_id: null }];
    await repo.ensureShop("1");
    expect(calls[0].sql).toContain("ON CONFLICT (guild_id) DO NOTHING");
});

test("listLiveItems skips removed items and sorts", async () => {
    calls.length = 0;
    rows = [];
    await repo.listLiveItems("1");
    expect(calls[0].sql).toContain("removed_at IS NULL");
    expect(calls[0].sql).toContain("ORDER BY sort_order");
});

test("removeItem soft-deletes", async () => {
    calls.length = 0;
    await repo.removeItem("1", 5);
    expect(calls[0].sql).toContain("removed_at = NOW()");
    expect(calls[0].sql).not.toContain("DELETE");
});

test("insertItem appends after the live maximum", async () => {
    calls.length = 0;
    rows = [{ id: 1 }];
    await repo.insertItem("1", {
        name: "A",
        description: null,
        emoji: null,
        image_url: null,
        price: 5,
        kind: "manual",
        role_id: null,
        duration_s: null,
        stock: null,
        max_per_member: null,
    });
    expect(calls[0].sql).toContain("MAX(sort_order)");
    expect(calls[0].sql).toContain("removed_at IS NULL");
});

test("moveItem swaps with the neighbour and stops at the ends", async () => {
    calls.length = 0;
    rows = [
        { id: 1, sort_order: 1 },
        { id: 2, sort_order: 2 },
    ];
    expect(await repo.moveItem("1", 2, "up")).toBe(true);
    expect(calls.filter((c) => c.sql.includes("UPDATE bh_shop_items"))).toHaveLength(2);
    calls.length = 0;
    expect(await repo.moveItem("1", 1, "up")).toBe(false);
    expect(calls.filter((c) => c.sql.includes("UPDATE bh_shop_items"))).toHaveLength(0);
});
