import { describe, expect, test } from "bun:test";
import type { PurchaseRow, ShopItemRow } from "../types";
import { blockerLabel, buyBlocker, deliverFlow, purchaseItem, refundFlow, roleProblem, type ShopDeps } from "./shop.service";

const item = (over: Partial<ShopItemRow> = {}): ShopItemRow => ({
    id: 1,
    guild_id: "g1",
    name: "Thing",
    description: null,
    emoji: null,
    image_url: null,
    price: 100,
    kind: "manual",
    role_id: null,
    duration_s: null,
    stock: null,
    max_per_member: null,
    sort_order: 0,
    removed_at: null,
    ...over,
});

const purchase = (over: Partial<PurchaseRow> = {}): PurchaseRow =>
    ({ id: 7, code: "ABC234", guild_id: "g1", user_id: 3, buyer_discord_id: "u1", role_id: null, kind: "manual", ...over }) as PurchaseRow;

const base = { seeds: 1000, bought: 0, holdsRole: false, activeGrantEnd: null };

describe("buyBlocker", () => {
    test("null when buyable", () => expect(buyBlocker({ item: item(), ...base })).toBeNull());
    test("sold out first", () =>
        expect(buyBlocker({ item: item({ stock: 0, max_per_member: 1 }), ...base, bought: 1, seeds: 0 })).toEqual({ kind: "sold_out" }));
    test("limit", () => expect(buyBlocker({ item: item({ max_per_member: 1 }), ...base, bought: 1 })).toEqual({ kind: "limit", max: 1 }));
    test("has role for a permanent role", () =>
        expect(buyBlocker({ item: item({ kind: "role" }), ...base, holdsRole: true })).toEqual({ kind: "has_role" }));
    test("has role for a timed role without an active grant", () =>
        expect(buyBlocker({ item: item({ kind: "timed_role" }), ...base, holdsRole: true })).toEqual({ kind: "has_role" }));
    test("timed role with an active grant adds up", () =>
        expect(buyBlocker({ item: item({ kind: "timed_role" }), ...base, holdsRole: true, activeGrantEnd: new Date() })).toBeNull());
    test("short", () => expect(buyBlocker({ item: item({ price: 500 }), ...base, seeds: 200 })).toEqual({ kind: "short", short: 300 }));
});

describe("blockerLabel", () => {
    test("labels", () => {
        expect(blockerLabel({ kind: "short", short: 300 })).toBe("300 🌱 short");
        expect(blockerLabel({ kind: "sold_out" })).toBe("Sold out");
        expect(blockerLabel({ kind: "has_role" })).toBe("You have this role");
        expect(blockerLabel({ kind: "limit", max: 1 })).toBe("Limit reached (1)");
    });
});

describe("roleProblem", () => {
    const above = "⚠️ The bot can't give <@&r1> - move the bot's role above it.";
    test("missing role", () => expect(roleProblem(null, "g1", 10, true)).toBe("⚠️ That role no longer exists."));
    test("managed role", () => expect(roleProblem({ managed: true, id: "r1", position: 1 }, "g1", 10, true)).toBe(above));
    test("everyone role", () =>
        expect(roleProblem({ managed: false, id: "g1", position: 0 }, "g1", 10, true)).toBe(above.replace("r1", "g1")));
    test("role above the bot", () => expect(roleProblem({ managed: false, id: "r1", position: 10 }, "g1", 10, true)).toBe(above));
    test("no Manage Roles", () =>
        expect(roleProblem({ managed: false, id: "r1", position: 1 }, "g1", 10, false)).toBe(
            "⚠️ The bot needs Manage Roles to give <@&r1>.",
        ));
    test("giveable", () => expect(roleProblem({ managed: false, id: "r1", position: 1 }, "g1", 10, true)).toBeNull());
});

function fakeDeps(over: Partial<ShopDeps> = {}) {
    const calls: Record<string, unknown[][]> = {};
    const rec =
        <T>(name: string, impl: (...a: never[]) => T) =>
        (...a: never[]): T => {
            calls[name] = [...(calls[name] ?? []), a];
            return impl(...a);
        };
    const deps = {
        now: () => new Date("2026-01-01T00:00:00Z"),
        random: () => 0.1,
        economyOn: rec("economyOn", async () => true),
        getShop: rec("getShop", async () => ({ guild_id: "g1", open: true, sales_channel_id: null })),
        getItem: rec("getItem", async () => item()),
        buyItem: rec("buyItem", async () => ({ kind: "ok", purchase: purchase(), seedsLeft: 5 })),
        refundPurchase: rec("refundPurchase", async () => ({ kind: "ok", purchase: purchase(), removeRole: false, stockRestored: false })),
        markDelivered: rec("markDelivered", async () => ({ kind: "ok", purchase: purchase() })),
        getPurchaseByCode: rec("getPurchaseByCode", async () => purchase()),
        refundWouldRemoveRole: rec("refundWouldRemoveRole", async () => false),
        addRole: rec("addRole", async () => {}),
        removeRole: rec("removeRole", async () => {}),
        postSale: rec("postSale", async () => {}),
        updateSalePost: rec("updateSalePost", async () => {}),
        log: rec("log", async () => {}),
        ...over,
    } as ShopDeps;
    return { deps, calls };
}

const input = { guildId: "g1", itemId: 1, userId: 3, buyerDiscordId: "u1", expectedPrice: 100 };
const roleOk = (kind: "role" | "timed_role") => async () => ({
    kind: "ok" as const,
    purchase: purchase({ kind, role_id: "r1" }),
    seedsLeft: 1,
});
const clash = () => Object.assign(new Error("dup"), { code: "23505" });

describe("purchaseItem", () => {
    test("closed when the economy is off", async () => {
        const { deps, calls } = fakeDeps({ economyOn: async () => false });
        expect(await purchaseItem(deps, input)).toEqual({ kind: "closed" });
        expect(calls.buyItem).toBeUndefined();
    });
    test("closed when the shop is closed or missing", async () => {
        for (const shop of [{ guild_id: "g1", open: false, sales_channel_id: null }, null]) {
            const { deps, calls } = fakeDeps({ getShop: async () => shop });
            expect(await purchaseItem(deps, input)).toEqual({ kind: "closed" });
            expect(calls.buyItem).toBeUndefined();
        }
    });
    test("ok posts the sale", async () => {
        const { deps, calls } = fakeDeps();
        expect((await purchaseItem(deps, input)).kind).toBe("ok");
        expect(calls.postSale).toHaveLength(1);
        expect((calls.postSale[0][0] as PurchaseRow).code).toBe("ABC234");
        expect(calls.addRole).toBeUndefined();
    });
    test("passes a buy blocker through", async () => {
        const { deps, calls } = fakeDeps({ buyItem: async () => ({ kind: "sold_out" }) });
        expect(await purchaseItem(deps, input)).toEqual({ kind: "sold_out" });
        expect(calls.postSale).toBeUndefined();
    });
    test("retries on a code clash with a new code", async () => {
        let n = 0;
        const codes: string[] = [];
        const { deps } = fakeDeps({
            random: () => (n++ < 6 ? 0.1 : 0.9),
            buyItem: async (i) => {
                codes.push(i.code);
                if (codes.length === 1) throw clash();
                return { kind: "ok", purchase: purchase(), seedsLeft: 1 };
            },
        });
        expect((await purchaseItem(deps, input)).kind).toBe("ok");
        expect(codes).toHaveLength(2);
        expect(codes[0]).not.toBe(codes[1]);
    });
    test("rethrows other errors and gives up after 5 clashes", async () => {
        const boom = fakeDeps({
            buyItem: async () => {
                throw new Error("db");
            },
        });
        await expect(purchaseItem(boom.deps, input)).rejects.toThrow("db");
        let tries = 0;
        const loop = fakeDeps({
            buyItem: async () => {
                tries++;
                throw clash();
            },
        });
        await expect(purchaseItem(loop.deps, input)).rejects.toThrow("dup");
        expect(tries).toBe(5);
    });
    test("role kinds add the role", async () => {
        const { deps, calls } = fakeDeps({ buyItem: roleOk("role") });
        expect((await purchaseItem(deps, input)).kind).toBe("ok");
        expect(calls.addRole[0]).toEqual(["g1", "u1", "r1"]);
    });
    test("addRole failure refunds, logs once and still posts the sale", async () => {
        let arg: unknown;
        const { deps, calls } = fakeDeps({
            buyItem: roleOk("timed_role"),
            addRole: async () => {
                throw new Error("nope");
            },
            refundPurchase: async (i) => {
                arg = i;
                return { kind: "ok", purchase: purchase({ status: "refunded" }), removeRole: false, stockRestored: true };
            },
        });
        const out = await purchaseItem(deps, input);
        expect(out.kind).toBe("role_failed");
        expect(arg).toMatchObject({ guildId: "g1", code: "ABC234", reason: "role_failed", by: null });
        expect(calls.log).toHaveLength(1);
        expect(calls.postSale).toHaveLength(1);
        const entry = calls.log[0][1] as { kind: string; title: string; body: string };
        expect(entry.kind).toBe("warning");
        expect(entry.title).toBe("⚠️ Couldn't give a shop role");
        expect(entry.body).toContain("<@&r1>");
        expect(entry.body).toContain("<@u1>");
        expect(entry.body).toContain("ABC234");
    });
    test.each([
        [
            "a throwing refund",
            async () => {
                throw new Error("db");
            },
        ],
        ["a not_found refund", async () => ({ kind: "not_found" as const })],
    ])("%s still logs, says to refund by hand and returns role_failed", async (_name, refundPurchase) => {
        const { deps, calls } = fakeDeps({
            buyItem: roleOk("role"),
            addRole: async () => {
                throw new Error("nope");
            },
            refundPurchase,
        });
        expect((await purchaseItem(deps, input)).kind).toBe("role_failed");
        expect(calls.log).toHaveLength(1);
        const body = (calls.log[0][1] as { body: string }).body;
        expect(body).toContain("refund `ABC234` by hand");
        expect(body).not.toContain("Seeds went back");
        expect(calls.postSale).toHaveLength(1);
    });
    test("a throwing postSale keeps the ok outcome", async () => {
        const { deps } = fakeDeps({
            postSale: async () => {
                throw new Error("no channel");
            },
        });
        expect((await purchaseItem(deps, input)).kind).toBe("ok");
    });
});

describe("refundFlow", () => {
    const withRole = (removeRole: boolean) => async () => ({
        kind: "ok" as const,
        purchase: purchase({ role_id: "r1" }),
        removeRole,
        stockRestored: false,
    });
    test("removes the role only when asked, always updates the post", async () => {
        const a = fakeDeps({ refundPurchase: withRole(true) });
        await refundFlow(a.deps, "g1", "ABC234", "admin");
        expect(a.calls.removeRole[0]).toEqual(["g1", "u1", "r1"]);
        expect(a.calls.updateSalePost).toHaveLength(1);
        const b = fakeDeps({ refundPurchase: withRole(false) });
        await refundFlow(b.deps, "g1", "ABC234", "admin");
        expect(b.calls.removeRole).toBeUndefined();
        expect(b.calls.updateSalePost).toHaveLength(1);
    });
    test("a removeRole failure is logged and the refund stands", async () => {
        const { deps, calls } = fakeDeps({
            refundPurchase: withRole(true),
            removeRole: async () => {
                throw new Error("x");
            },
        });
        expect((await refundFlow(deps, "g1", "ABC234", "admin")).kind).toBe("ok");
        expect(calls.log).toHaveLength(1);
        expect(calls.updateSalePost).toHaveLength(1);
    });
    test("not ok does nothing more", async () => {
        const { deps, calls } = fakeDeps({ refundPurchase: async () => ({ kind: "not_found" }) });
        expect(await refundFlow(deps, "g1", "X", "admin")).toEqual({ kind: "not_found" });
        expect(calls.updateSalePost).toBeUndefined();
    });
});

describe("deliverFlow", () => {
    test("updates the post on ok", async () => {
        const { deps, calls } = fakeDeps();
        expect((await deliverFlow(deps, "g1", "ABC234", "admin")).kind).toBe("ok");
        expect(calls.updateSalePost).toHaveLength(1);
    });
    test("not_pending never updates the post", async () => {
        const { deps, calls } = fakeDeps({ markDelivered: async () => ({ kind: "not_pending", purchase: purchase() }) });
        expect((await deliverFlow(deps, "g1", "ABC234", "admin")).kind).toBe("not_pending");
        expect(calls.updateSalePost).toBeUndefined();
    });
});
