import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import * as connection from "@/database/connection";
import type { PurchaseRow, ShopItemRow } from "../types";
import * as repo from "./purchases.repository";

const calls: Array<{ sql: string; params: unknown[] }> = [];
/** Scripted replies: the first matching entry (by SQL substring) wins; anything else returns no rows. */
let script: Array<{ match: string; rows: unknown[] }> = [];

const run = async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    const hit = script.find((entry) => sql.includes(entry.match));
    const rows = hit?.rows ?? [];
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
beforeEach(() => {
    calls.length = 0;
    script = [];
});

const NOW = new Date("2026-10-23T12:00:00Z");
const sqlOf = (needle: string) => calls.filter((c) => c.sql.includes(needle));

function item(over: Partial<ShopItemRow> = {}): ShopItemRow {
    return {
        id: 7,
        guild_id: "g1",
        name: "Thing",
        description: null,
        emoji: "🎁",
        image_url: null,
        price: 500,
        kind: "manual",
        role_id: null,
        duration_s: null,
        stock: null,
        max_per_member: null,
        sort_order: 1,
        removed_at: null,
        ...over,
    };
}

function purchase(over: Partial<PurchaseRow> = {}): PurchaseRow {
    return {
        id: 1,
        code: "ABC234",
        guild_id: "g1",
        item_id: 7,
        user_id: 3,
        buyer_discord_id: "d3",
        item_name: "Thing",
        item_emoji: null,
        price: 500,
        kind: "manual",
        role_id: null,
        duration_s: null,
        role_ends_at: null,
        status: "delivered",
        refund_reason: null,
        decided_by: null,
        decided_at: null,
        post_channel_id: null,
        post_message_id: null,
        created_at: NOW,
        ...over,
    };
}

const buyInput = { guildId: "g1", itemId: 7, userId: 3, buyerDiscordId: "d3", expectedPrice: 500, code: "ABC234", now: NOW };

test("buyItem locks the live item row", async () => {
    await repo.buyItem(buyInput);
    const select = calls[0].sql;
    expect(select).toContain("FROM bh_shop_items");
    expect(select).toContain("FOR UPDATE");
    expect(select).toContain("removed_at IS NULL");
});

test("buyItem returns gone when the item is missing", async () => {
    expect(await repo.buyItem(buyInput)).toEqual({ kind: "gone" });
});

test("buyItem reports a changed price and writes nothing", async () => {
    script = [{ match: "FROM bh_shop_items", rows: [item({ price: 600 })] }];
    expect(await repo.buyItem(buyInput)).toEqual({ kind: "price_changed", price: 600 });
    expect(calls.some((c) => /^\s*(UPDATE|INSERT)/.test(c.sql))).toBe(false);
});

test("buyItem returns sold_out at zero stock", async () => {
    script = [{ match: "FROM bh_shop_items", rows: [item({ stock: 0 })] }];
    expect(await repo.buyItem(buyInput)).toEqual({ kind: "sold_out" });
    expect(sqlOf("UPDATE bh_users")).toHaveLength(0);
});

test("buyItem returns limit when the member already holds max", async () => {
    script = [
        { match: "FROM bh_shop_items", rows: [item({ max_per_member: 2 })] },
        { match: "COUNT(*)", rows: [{ count: "2" }] },
    ];
    expect(await repo.buyItem(buyInput)).toEqual({ kind: "limit", max: 2 });
    expect(sqlOf("UPDATE bh_users")).toHaveLength(0);
});

test("buyItem returns short with the missing amount", async () => {
    script = [
        { match: "FROM bh_shop_items", rows: [item()] },
        { match: "SELECT seeds FROM bh_users", rows: [{ seeds: 200 }] },
    ];
    expect(await repo.buyItem(buyInput)).toEqual({ kind: "short", short: 300 });
    const spend = sqlOf("UPDATE bh_users")[0];
    expect(spend.sql).toContain("seeds >= ");
    expect(sqlOf("INSERT INTO bh_shop_purchases")).toHaveLength(0);
});

test("buyItem inserts a manual purchase as pending", async () => {
    script = [
        { match: "FROM bh_shop_items", rows: [item()] },
        { match: "UPDATE bh_users", rows: [{ seeds: 40 }] },
        { match: "INSERT INTO bh_shop_purchases", rows: [purchase({ status: "pending" })] },
    ];
    const res = await repo.buyItem(buyInput);
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") expect(res.seedsLeft).toBe(40);
    expect(sqlOf("INSERT INTO bh_shop_purchases")[0].params).toContain("pending");
    expect(sqlOf("UPDATE bh_shop_items")).toHaveLength(0);
});

test("buyItem inserts a role purchase as delivered and takes stock", async () => {
    script = [
        { match: "FROM bh_shop_items", rows: [item({ kind: "role", role_id: "r1", stock: 3 })] },
        { match: "UPDATE bh_users", rows: [{ seeds: 40 }] },
        { match: "INSERT INTO bh_shop_purchases", rows: [purchase({ kind: "role", status: "delivered" })] },
    ];
    await repo.buyItem(buyInput);
    expect(sqlOf("INSERT INTO bh_shop_purchases")[0].params).toContain("delivered");
    expect(sqlOf("SET stock = stock - 1")).toHaveLength(1);
    expect(sqlOf("bh_shop_role_grants")).toHaveLength(0);
});

test("buyItem upserts the timed grant from the later of now and the old end", async () => {
    const end = new Date("2026-10-30T12:00:00Z");
    script = [
        { match: "FROM bh_shop_items", rows: [item({ kind: "timed_role", role_id: "r1", duration_s: 604800 })] },
        { match: "UPDATE bh_users", rows: [{ seeds: 40 }] },
        { match: "INSERT INTO bh_shop_role_grants", rows: [{ ends_at: end }] },
        { match: "INSERT INTO bh_shop_purchases", rows: [purchase({ kind: "timed_role", role_ends_at: end })] },
    ];
    await repo.buyItem(buyInput);
    const grant = sqlOf("INSERT INTO bh_shop_role_grants")[0];
    expect(grant.sql).toContain("GREATEST(");
    expect(grant.sql).toContain("ON CONFLICT (user_id, role_id)");
    const sync = sqlOf("SET role_ends_at");
    expect(sync).toHaveLength(1);
    expect(sync[0].params).toContain(end);
    expect(sqlOf("INSERT INTO bh_shop_purchases")[0].params).toContain(end);
});

test("buyItem lets a code clash surface as the pg error", async () => {
    const clash = Object.assign(new Error("duplicate key"), { code: "23505" });
    script = [
        { match: "FROM bh_shop_items", rows: [item()] },
        { match: "UPDATE bh_users", rows: [{ seeds: 40 }] },
    ];
    const original = run;
    spies.push(
        spyOn(connection, "transaction").mockImplementationOnce((async (fn: (client: unknown) => Promise<unknown>) =>
            fn({
                query: async (sql: string, params: unknown[] = []) => {
                    if (sql.includes("INSERT INTO bh_shop_purchases")) throw clash;
                    return original(sql, params);
                },
            })) as never),
    );
    await expect(repo.buyItem(buyInput)).rejects.toMatchObject({ code: "23505" });
});

const refundInput = { guildId: "g1", code: "ABC234", by: "admin1", reason: null, now: NOW };

test("refundPurchase returns not_found for an unknown code", async () => {
    expect(await repo.refundPurchase(refundInput)).toEqual({ kind: "not_found" });
});

test("refundPurchase refuses a second refund and writes nothing", async () => {
    script = [{ match: "AND code = $2", rows: [purchase({ status: "refunded" })] }];
    const res = await repo.refundPurchase(refundInput);
    expect(res.kind).toBe("already_refunded");
    expect(calls.some((c) => /^\s*(UPDATE|INSERT|DELETE)/.test(c.sql))).toBe(false);
    expect(calls[0].sql).toContain("FOR UPDATE");
});

test("refundPurchase gives the Seeds back and marks the purchase refunded", async () => {
    script = [{ match: "AND code = $2", rows: [purchase()] }];
    const res = await repo.refundPurchase({ ...refundInput, reason: "role_failed" });
    expect(res.kind).toBe("ok");
    const credit = sqlOf("UPDATE bh_users")[0];
    expect(credit.params).toEqual([3, 500, 0]);
    const mark = sqlOf("SET status = 'refunded'")[0];
    expect(mark.params).toContain("role_failed");
    expect(mark.params).toContain("admin1");
    if (res.kind === "ok") expect(res.removeRole).toBe(false);
});

test("refundPurchase restores stock only for a live item", async () => {
    script = [
        { match: "AND code = $2", rows: [purchase()] },
        { match: "SET stock = stock + 1", rows: [{ id: 7 }] },
    ];
    const live = await repo.refundPurchase(refundInput);
    expect(live.kind === "ok" && live.stockRestored).toBe(true);

    script = [{ match: "AND code = $2", rows: [purchase()] }];
    const removed = await repo.refundPurchase(refundInput);
    expect(removed.kind === "ok" && removed.stockRestored).toBe(false);
    expect(sqlOf("SET stock = stock + 1")[0].sql).toContain("removed_at IS NULL");
});

test("refundPurchase keeps a permanent role another purchase still gives", async () => {
    script = [
        { match: "AND code = $2", rows: [purchase({ kind: "role", role_id: "r1" })] },
        { match: "AS held", rows: [{ held: true }] },
    ];
    const res = await repo.refundPurchase(refundInput);
    expect(res.kind === "ok" && res.removeRole).toBe(false);
});

test("refundPurchase removes a permanent role nothing else gives", async () => {
    script = [
        { match: "AND code = $2", rows: [purchase({ kind: "role", role_id: "r1" })] },
        { match: "AS held", rows: [{ held: false }] },
    ];
    const res = await repo.refundPurchase(refundInput);
    expect(res.kind === "ok" && res.removeRole).toBe(true);
});

const timed = () => purchase({ kind: "timed_role", role_id: "r1", duration_s: 86400 });

test("refundPurchase moves a timed grant back and keeps the role while the end is ahead", async () => {
    const end = new Date("2026-10-25T12:00:00Z");
    script = [
        { match: "AND code = $2", rows: [timed()] },
        { match: "FROM bh_shop_role_grants", rows: [{ ends_at: end }] },
    ];
    const res = await repo.refundPurchase(refundInput);
    expect(res.kind === "ok" && res.removeRole).toBe(false);
    const update = sqlOf("UPDATE bh_shop_role_grants")[0];
    expect(update.params).toContain(new Date("2026-10-24T12:00:00Z").toISOString());
    expect(sqlOf("DELETE FROM bh_shop_role_grants")).toHaveLength(0);
    expect(sqlOf("SET role_ends_at")).toHaveLength(1);
});

test("refundPurchase deletes the grant and removes the role when the end falls in the past", async () => {
    const end = new Date("2026-10-24T00:00:00Z");
    script = [
        { match: "AND code = $2", rows: [timed()] },
        { match: "FROM bh_shop_role_grants", rows: [{ ends_at: end }] },
    ];
    const res = await repo.refundPurchase(refundInput);
    expect(res.kind === "ok" && res.removeRole).toBe(true);
    expect(sqlOf("DELETE FROM bh_shop_role_grants")).toHaveLength(1);
    expect(sqlOf("UPDATE bh_shop_role_grants")).toHaveLength(0);
});

test("refundWouldRemoveRole reads without writing", async () => {
    script = [{ match: "AS held", rows: [{ held: false }] }];
    expect(await repo.refundWouldRemoveRole(purchase({ kind: "role", role_id: "r1" }), NOW)).toBe(true);
    expect(calls.some((c) => /^\s*(UPDATE|INSERT|DELETE)/.test(c.sql))).toBe(false);
    expect(await repo.refundWouldRemoveRole(purchase(), NOW)).toBe(false);
});

const decideInput = { guildId: "g1", code: "ABC234", by: "admin1", now: NOW };

test("markDelivered flips a pending purchase with a compare-and-set", async () => {
    script = [{ match: "SET status = 'delivered'", rows: [purchase()] }];
    expect((await repo.markDelivered(decideInput)).kind).toBe("ok");
    expect(calls[0].sql).toContain("status = 'pending'");
});

test("markDelivered tells not_pending from not_found", async () => {
    script = [{ match: "SELECT", rows: [purchase({ status: "refunded" })] }];
    expect((await repo.markDelivered(decideInput)).kind).toBe("not_pending");
    script = [];
    expect(await repo.markDelivered(decideInput)).toEqual({ kind: "not_found" });
});

test("listPurchases filters pending, pages newest first and counts", async () => {
    script = [
        { match: "COUNT(*)", rows: [{ count: "12" }] },
        { match: "ORDER BY", rows: [purchase()] },
    ];
    const res = await repo.listPurchases("g1", "pending", 10, 5);
    expect(res.total).toBe(12);
    expect(res.rows).toHaveLength(1);
    const page = sqlOf("ORDER BY")[0];
    expect(page.sql).toContain("created_at DESC");
    expect(page.sql).toContain("status = 'pending'");
    expect(page.params).toEqual(["g1", 5, 10]);
});

test("countMemberItemPurchases ignores refunded purchases", async () => {
    script = [{ match: "COUNT(*)", rows: [{ count: "3" }] }];
    expect(await repo.countMemberItemPurchases(7, 3)).toBe(3);
    expect(calls[0].sql).toContain("status <> 'refunded'");
});

test("getActiveGrantEnd returns null when no grant is active", async () => {
    expect(await repo.getActiveGrantEnd(3, "r1", NOW)).toBeNull();
    expect(calls[0].sql).toContain("ends_at > ");
});

test("getDueGrants maps rows with the Discord id", async () => {
    script = [{ match: "bh_shop_role_grants", rows: [{ user_id: 3, guild_id: "g1", discord_user_id: "d3", role_id: "r1" }] }];
    expect(await repo.getDueGrants(NOW, 50)).toEqual([{ userId: 3, guildId: "g1", discordUserId: "d3", roleId: "r1" }]);
    expect(calls[0].sql).toContain("ends_at <= ");
});
