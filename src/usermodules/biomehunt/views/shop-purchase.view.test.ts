import { expect, test } from "bun:test";
import { createFakeViewTransport, type ViewPayload } from "@/define";
import type { ShopDeps } from "../services/shop.service";
import type { PurchaseRow, ShopItemRow } from "../types";
import { buildSalePost, purchaseCardView, statusBanner, statusColor } from "./shop-purchase.view";

const ADMIN = "admin1";
const created = new Date("2026-01-01T00:00:00Z");
const decided = new Date("2026-01-02T00:00:00Z");

const purchase = (over: Partial<PurchaseRow> = {}): PurchaseRow => ({
    id: 7,
    code: "K7Q2MX",
    guild_id: "g1",
    item_id: 1,
    user_id: 3,
    buyer_discord_id: "u1",
    item_name: "Sticker",
    item_emoji: "🎟️",
    price: 500,
    kind: "manual",
    role_id: null,
    duration_s: null,
    role_ends_at: null,
    role_window_start: null,
    status: "pending",
    refund_reason: null,
    decided_by: null,
    decided_at: null,
    post_channel_id: null,
    post_message_id: null,
    created_at: created,
    ...over,
});

const item = (over: Partial<ShopItemRow> = {}): ShopItemRow => ({
    id: 1,
    guild_id: "g1",
    name: "Sticker",
    description: null,
    emoji: null,
    image_url: null,
    price: 500,
    kind: "manual",
    role_id: null,
    duration_s: null,
    stock: null,
    max_per_member: null,
    sort_order: 0,
    removed_at: null,
    ...over,
});

function walkText(node: unknown, out: string[]) {
    if (node === null || typeof node !== "object") return;
    const json = typeof (node as { toJSON?: unknown }).toJSON === "function" ? (node as { toJSON(): unknown }).toJSON() : node;
    if (Array.isArray(json)) {
        for (const child of json) walkText(child, out);
        return;
    }
    const obj = json as { content?: string; label?: string; components?: unknown; accessory?: unknown };
    if (obj.content) out.push(obj.content);
    if (obj.label) out.push(`<<${obj.label}>>`);
    walkText(obj.components, out);
    walkText(obj.accessory, out);
}
const text = (payload: ViewPayload) => {
    const out: string[] = [];
    walkText(payload.components, out);
    return out.join("\n");
};
const postText = (p: PurchaseRow) => text({ components: buildSalePost(p).components });

test("statusBanner names each of the five states and the code", () => {
    const cases: [Partial<PurchaseRow>, string, string][] = [
        [{}, "● PENDING", "\u001b[1;33m"],
        [{ status: "delivered", kind: "role" }, "● ROLE GIVEN", "\u001b[1;32m"],
        [{ status: "delivered" }, "● DELIVERED", "\u001b[1;32m"],
        [{ status: "refunded" }, "● REFUNDED", "\u001b[1;30m"],
        [{ status: "refunded", refund_reason: "role_failed" }, "● REFUNDED - ROLE FAILED", "\u001b[1;31m"],
    ];
    for (const [over, label, color] of cases) {
        const banner = statusBanner(purchase(over));
        expect(banner).toContain("```ansi");
        expect(banner).toContain(`${color}${label}`);
        expect(banner).toContain("\u001b[37m#K7Q2MX");
    }
});

test("statusColor maps role_failed to the failed colour", () => {
    expect(statusColor(purchase())).toBe(0xf0b232);
    expect(statusColor(purchase({ status: "delivered" }))).toBe(0x3ba55d);
    expect(statusColor(purchase({ status: "refunded" }))).toBe(0x80848e);
    expect(statusColor(purchase({ status: "refunded", refund_reason: "role_failed" }))).toBe(0xda373c);
});

test("buildSalePost carries the Manage customId and never pings", () => {
    const post = buildSalePost(purchase());
    const json = JSON.stringify(post.components.map((c) => c.toJSON()));
    expect(json).toContain("biomehunt:shop-manage:K7Q2MX");
    expect(json).not.toContain("allowed_mentions");
    expect(post.allowedMentions).toEqual({ parse: [] });
});

test("buildSalePost second line by status", () => {
    expect(postText(purchase())).toContain("<@u1> · <t:1767225600:R>");
    expect(postText(purchase({ status: "delivered", decided_by: "a1", decided_at: decided }))).toContain(
        "<@u1> · delivered by <@a1> <t:1767312000:R>",
    );
    expect(postText(purchase({ status: "refunded", decided_by: "a1", decided_at: decided }))).toContain(
        "<@u1> · refunded by <@a1> <t:1767312000:R>",
    );
    expect(postText(purchase({ status: "refunded", refund_reason: "role_failed", kind: "role", role_id: "r1" }))).toContain(
        "<@u1> · the bot couldn't give <@&r1>",
    );
});

test("role given shows until only for a timed role", () => {
    const timed = postText(
        purchase({ status: "delivered", kind: "timed_role", role_id: "r1", role_ends_at: new Date("2026-02-01T00:00:00Z") }),
    );
    expect(timed).toContain("<@u1> · <@&r1> until <t:1769904000:D>");
    const permanent = postText(purchase({ status: "delivered", kind: "role", role_id: "r1" }));
    expect(permanent).toContain("<@u1> · <@&r1>");
    expect(permanent).not.toContain("until <t:");
});

test("a renamed item still renders the purchase snapshot", () => {
    expect(postText(purchase({ item_name: "Old name" }))).toContain("🎟️ **Old name** · `500 🌱`");
});

function deps(state: { p: PurchaseRow }, over: Partial<ShopDeps> = {}) {
    const calls: string[] = [];
    const d = {
        now: () => new Date("2026-01-03T00:00:00Z"),
        getPurchaseByCode: async () => state.p,
        getItem: async () => item(),
        refundRoleImpact: async () => ({ removeRole: false, lostSeconds: 0 }),
        markDelivered: async () => {
            calls.push("deliver");
            state.p = purchase({ status: "delivered", decided_by: ADMIN, decided_at: decided });
            return { kind: "ok", purchase: state.p };
        },
        refundPurchase: async () => {
            calls.push("refund");
            state.p = purchase({ status: "refunded", decided_by: ADMIN, decided_at: decided });
            return { kind: "ok", purchase: state.p, removeRole: false, stockRestored: false };
        },
        updateSalePost: async () => {},
        removeRole: async () => {},
        log: async () => {},
        ...over,
    } as unknown as ShopDeps;
    return { d, calls };
}

async function open(p: PurchaseRow, fromMenu = false, over: Partial<ShopDeps> = {}) {
    const state = { p };
    const { d, calls } = deps(state, over);
    const fake = createFakeViewTransport();
    const done = fake.run(purchaseCardView(d), { guildId: "g1", code: p.code, fromMenu }, ADMIN);
    await fake.flush();
    return { fake, calls, state, done };
}

/** A click as an administrator (or not): the card re-checks the permission on the raw interaction. */
const asAdmin = <E extends { userId: string }>(e: E, admin = true): E => ({
    ...e,
    raw: { user: { id: e.userId }, memberPermissions: { has: () => admin } },
});

const buttons = (t: string) => [...t.matchAll(/<<([^>]+)>>/g)].map((m) => m[1]);

test("card buttons by status", async () => {
    expect(buttons(text((await open(purchase())).fake.lastPayload()))).toEqual(["Mark delivered", "Refund"]);
    expect(buttons(text((await open(purchase({ status: "delivered" }))).fake.lastPayload()))).toEqual(["Refund"]);
    expect(buttons(text((await open(purchase({ status: "refunded" }))).fake.lastPayload()))).toEqual([]);
});

test("Back only when opened from the menu, and it closes the view", async () => {
    expect(buttons(text((await open(purchase())).fake.lastPayload()))).not.toContain("Back");
    const { fake, done } = await open(purchase(), true);
    expect(buttons(text(fake.lastPayload()))).toEqual(["Mark delivered", "Refund", "Back"]);
    await fake.emit(fake.click("back", ADMIN));
    await done;
});

test("card shows banner, item, buyer and the timed role end", async () => {
    const { fake } = await open(
        purchase({ kind: "timed_role", role_id: "r1", role_ends_at: new Date("2026-02-01T00:00:00Z"), status: "delivered" }),
    );
    const t = text(fake.lastPayload());
    expect(t).toContain("#K7Q2MX");
    expect(t).toContain("🎟️ **Sticker** · `500 🌱`");
    expect(t).toContain("Bought by <@u1> · <t:1767225600:f>");
    expect(t).toContain("<@&r1> until <t:1769904000:D>");
});

test("Mark delivered runs the flow and redraws", async () => {
    const { fake, calls } = await open(purchase());
    await fake.emit(asAdmin(fake.click("deliver", ADMIN)));
    await fake.flush();
    expect(calls).toEqual(["deliver"]);
    expect(text(fake.lastPayload())).toContain("● DELIVERED");
    expect(buttons(text(fake.lastPayload()))).toEqual(["Refund"]);
});

test("a stale Mark delivered tells the current status", async () => {
    const { fake } = await open(purchase(), false, {
        markDelivered: async () => ({ kind: "not_pending", purchase: purchase({ status: "refunded" }) }),
    } as never);
    await fake.emit(asAdmin(fake.click("deliver", ADMIN)));
    await fake.flush();
    expect(fake.notifies.map((n) => n.content)).toEqual(["This purchase is already refunded."]);
    expect(buttons(text(fake.lastPayload()))).toEqual([]);
});

test("the refund confirm lists only what applies", async () => {
    const full = await open(purchase({ kind: "role", role_id: "r1" }), false, {
        refundRoleImpact: async () => ({ removeRole: true, lostSeconds: 0 }),
        getItem: async () => item({ stock: 4 }),
    });
    await full.fake.emit(asAdmin(full.fake.click("refund", ADMIN)));
    await full.fake.flush();
    const t = text(full.fake.lastPayload());
    expect(t).toContain("**Refund `#K7Q2MX`?**");
    expect(t).toContain("- `500 🌱` go back to <@u1>");
    expect(t).toContain("- <@&r1> is removed");
    expect(t).toContain("- The stock goes back to 5");

    const bare = await open(purchase({ price: 0 }), false, { getItem: async () => item({ removed_at: new Date(), stock: 4 }) });
    await bare.fake.emit(asAdmin(bare.fake.click("refund", ADMIN)));
    await bare.fake.flush();
    expect(text(bare.fake.lastPayload())).not.toContain("stock");
    expect(text(bare.fake.lastPayload())).not.toContain("go back");

    const unlimited = await open(purchase());
    await unlimited.fake.emit(asAdmin(unlimited.fake.click("refund", ADMIN)));
    await unlimited.fake.flush();
    expect(text(unlimited.fake.lastPayload())).not.toContain("stock");
});

test("a timed role that stays says how much of it is unused", async () => {
    const { fake } = await open(purchase({ kind: "timed_role", role_id: "r1", duration_s: 7 * 86400, status: "delivered" }), false, {
        refundRoleImpact: async () => ({ removeRole: false, lostSeconds: 90000 }),
    });
    await fake.emit(asAdmin(fake.click("refund", ADMIN)));
    await fake.flush();
    expect(text(fake.lastPayload())).toContain("- <@&r1> loses 1d1h");
});

test("a timed role with no unused time has no loses bullet", async () => {
    const { fake } = await open(purchase({ kind: "timed_role", role_id: "r1", duration_s: 7 * 86400, status: "delivered" }));
    await fake.emit(asAdmin(fake.click("refund", ADMIN)));
    await fake.flush();
    expect(text(fake.lastPayload())).not.toContain("loses");
});

test("a refund whose buyer has no profile says the Seeds cannot go back", async () => {
    const { fake } = await open(purchase({ user_id: null }));
    await fake.emit(asAdmin(fake.click("refund", ADMIN)));
    await fake.flush();
    const t = text(fake.lastPayload());
    expect(t).toContain("- `500 🌱` can't go back - <@u1> has no profile anymore");
    expect(t).not.toContain("go back to");
});

test("Mark delivered and Refund refuse a clicker who is not an administrator", async () => {
    const { fake, calls } = await open(purchase());
    await fake.emit(asAdmin(fake.click("deliver", ADMIN), false));
    await fake.emit(asAdmin(fake.click("refund", ADMIN), false));
    await fake.flush();
    expect(calls).toEqual([]);
    expect(fake.notifies.map((n) => n.content)).toEqual(["Only admins can manage purchases.", "Only admins can manage purchases."]);
});

test("a role purchase with no role never prints a null mention", () => {
    const t = postText(purchase({ kind: "role", role_id: null, status: "delivered" }));
    expect(t).not.toContain("null");
    expect(postText(purchase({ kind: "role", role_id: null, status: "refunded", refund_reason: "role_failed" }))).not.toContain("null");
    expect(postText(purchase({ status: "delivered", decided_by: null }))).not.toContain("null");
});

test("confirming the refund runs it and returns to the refunded card", async () => {
    const { fake, calls } = await open(purchase());
    await fake.emit(asAdmin(fake.click("refund", ADMIN)));
    await fake.flush();
    await fake.emit(fake.click("yes", ADMIN));
    await fake.flush();
    expect(calls).toEqual(["refund"]);
    expect(text(fake.lastPayload())).toContain("● REFUNDED");
    expect(buttons(text(fake.lastPayload()))).toEqual([]);
});

test("Cancel leaves the purchase alone", async () => {
    const { fake, calls } = await open(purchase());
    await fake.emit(asAdmin(fake.click("refund", ADMIN)));
    await fake.flush();
    await fake.emit(fake.click("no", ADMIN));
    await fake.flush();
    expect(calls).toEqual([]);
    expect(text(fake.lastPayload())).toContain("● PENDING");
});

test("a stale Refund on a refunded purchase is told the status without a confirm", async () => {
    const { fake, state } = await open(purchase());
    state.p = purchase({ status: "refunded" });
    await fake.emit(asAdmin(fake.click("refund", ADMIN)));
    await fake.flush();
    expect(fake.notifies.map((n) => n.content)).toEqual(["This purchase is already refunded."]);
    expect(text(fake.lastPayload())).toContain("● REFUNDED");
});
