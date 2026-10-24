import { expect, test } from "bun:test";
import { createFakeViewTransport, type ViewPayload } from "@/define";
import type { PurchaseOutcome } from "../services/shop.service";
import type { PurchaseRow, ShopItemRow, UserRow } from "../types";
import { type MemberShopDeps, memberShopView } from "./shop.view";

const OWNER = "owner";
const GUILD = "g1";
const NOW = new Date("2026-01-10T00:00:00Z");
const ts = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

type Json = {
    custom_id?: string;
    label?: string;
    disabled?: boolean;
    style?: number;
    content?: string;
    components?: Json[];
    accessory?: Json;
};

function flatten(payload: ViewPayload): Json[] {
    const out: Json[] = [];
    const walk = (node: unknown) => {
        if (node === null || typeof node !== "object") return;
        const json = typeof (node as { toJSON?: unknown }).toJSON === "function" ? (node as { toJSON(): unknown }).toJSON() : node;
        if (Array.isArray(json)) {
            for (const child of json) walk(child);
            return;
        }
        const obj = json as Json;
        out.push(obj);
        walk(obj.components);
        walk(obj.accessory);
    };
    walk(payload.components);
    return out;
}

const text = (payload: ViewPayload) =>
    flatten(payload)
        .map((c) => c.content ?? "")
        .filter(Boolean)
        .join("\n");
const labels = (payload: ViewPayload) => flatten(payload).flatMap((c) => (c.label ? [c.label] : []));
const button = (payload: ViewPayload, label: string) => flatten(payload).find((c) => c.label === label);

const ButtonSuccess = 3;

const user = (seeds: number): UserRow => ({ id: 7, guild_id: GUILD, discord_user_id: OWNER, seeds }) as UserRow;

const item = (id: number, over: Partial<ShopItemRow> = {}): ShopItemRow => ({
    id,
    guild_id: GUILD,
    name: `Item ${id}`,
    description: null,
    emoji: null,
    image_url: null,
    price: 500,
    kind: "manual",
    role_id: null,
    duration_s: null,
    stock: null,
    max_per_member: null,
    sort_order: id,
    removed_at: null,
    ...over,
});

const purchase = (n: number, over: Partial<PurchaseRow> = {}): PurchaseRow => ({
    id: n,
    code: `K7Q2M${n}`,
    guild_id: GUILD,
    item_id: 1,
    user_id: 7,
    buyer_discord_id: OWNER,
    item_name: `Thing ${n}`,
    item_emoji: null,
    price: 100,
    kind: "manual",
    role_id: null,
    duration_s: null,
    role_ends_at: null,
    status: "pending",
    refund_reason: null,
    decided_by: null,
    decided_at: null,
    post_channel_id: null,
    post_message_id: null,
    created_at: new Date("2026-01-01T00:00:00Z"),
    ...over,
});

interface Setup {
    seeds?: number;
    open?: boolean;
    shopExists?: boolean;
    economyOn?: boolean;
    items?: ShopItemRow[];
    purchases?: PurchaseRow[];
    bought?: number;
    holdsRole?: boolean;
    grantEnd?: Date | null;
    outcome?: PurchaseOutcome;
}

function fakeDeps(setup: Setup = {}) {
    const calls: unknown[][] = [];
    const data = {
        seeds: setup.seeds ?? 1250,
        economyOn: setup.economyOn ?? true,
        items: [...(setup.items ?? [])],
        holdsRole: setup.holdsRole ?? false,
    };
    const deps: MemberShopDeps = {
        now: () => NOW,
        economyOn: async () => data.economyOn,
        getShop: async () => (setup.shopExists === false ? null : { guild_id: GUILD, open: setup.open ?? true, sales_channel_id: null }),
        listLiveItems: async () => data.items,
        getItem: async (_g, id) => data.items.find((i) => i.id === id) ?? null,
        getSeeds: async () => data.seeds,
        listMemberPurchases: async (_u, offset, limit) => {
            const all = setup.purchases ?? [];
            return { rows: all.slice(offset, offset + limit), total: all.length };
        },
        countMemberItemPurchases: async () => setup.bought ?? 0,
        getActiveGrantEnd: async () => setup.grantEnd ?? null,
        holdsRole: () => data.holdsRole,
        purchaseItem: async (input) => {
            calls.push(["purchaseItem", input]);
            return setup.outcome ?? { kind: "closed" };
        },
    };
    return { deps, calls, data };
}

async function open(setup: Setup = {}) {
    const { deps, calls, data } = fakeDeps(setup);
    const fake = createFakeViewTransport();
    void fake.run(memberShopView(deps), { guildId: GUILD, user: user(data.seeds) }, OWNER);
    await fake.flush();
    return { fake, calls, data };
}

const buyCalls = (calls: unknown[][]) => calls.filter((c) => c[0] === "purchaseItem");

for (const [name, setup] of [
    ["a closed shop", { open: false }],
    ["economy off", { economyOn: false }],
    ["no shop", { shopExists: false }],
] as const) {
    test(`${name} renders "The shop is closed." and My purchases still works`, async () => {
        const { fake } = await open({ ...setup, items: [item(1)], purchases: [purchase(1)] });
        expect(text(fake.lastPayload())).toContain("## Shop\nThe shop is closed.");
        expect(text(fake.lastPayload())).not.toContain("Item 1");
        await fake.emit(fake.click("tab:purchases", OWNER));
        expect(text(fake.lastPayload())).toContain("**My purchases**");
        expect(text(fake.lastPayload())).toContain("`#K7Q2M1` · **Thing 1** · `100 🌱`");
    });
}

test("an open shop with no live items says nothing is for sale", async () => {
    const { fake } = await open();
    expect(text(fake.lastPayload())).toContain("You have `1,250 🌱`");
    expect(text(fake.lastPayload())).toContain("Nothing for sale yet.");
});

test("the list shows five items per page with View buttons and Sold out", async () => {
    const items = [item(1, { stock: 0 }), item(2), item(3), item(4), item(5), item(6)];
    const { fake } = await open({ items });
    const t = text(fake.lastPayload());
    expect(t).toContain("**Item 1** · `500 🌱`\n-# Sold out");
    expect(t).not.toContain("Item 6");
    expect(labels(fake.lastPayload()).filter((l) => l === "View")).toHaveLength(5);
    expect(labels(fake.lastPayload())).toContain("1 / 2");
});

test("200 Seeds on a 500 item renders a disabled short button instead of Buy", async () => {
    const { fake } = await open({ seeds: 200, items: [item(1)] });
    await fake.emit(fake.click("view:0", OWNER));
    const blocked = button(fake.lastPayload(), "300 🌱 short");
    expect(blocked?.disabled).toBe(true);
    expect(blocked?.style).toBe(ButtonSuccess);
    expect(button(fake.lastPayload(), "Buy")).toBeUndefined();
});

test("a sold-out item is disabled on the card", async () => {
    const { fake } = await open({ items: [item(1, { stock: 0 })] });
    await fake.emit(fake.click("view:0", OWNER));
    expect(button(fake.lastPayload(), "Sold out")?.disabled).toBe(true);
    expect(button(fake.lastPayload(), "Sold out")?.style).toBe(2);
});

test("the card offers Buy to a member who can buy", async () => {
    const { fake } = await open({ items: [item(1, { kind: "role", role_id: "r1", stock: 12, max_per_member: 1 })] });
    await fake.emit(fake.click("view:0", OWNER));
    expect(text(fake.lastPayload())).toContain("`500 🌱` · <@&r1> · 12 left · 1 per member");
    expect(button(fake.lastPayload(), "Buy")?.style).toBe(ButtonSuccess);
});

test("confirm for a timed role already active states both dates", async () => {
    const grantEnd = new Date("2026-01-13T00:00:00Z");
    const role = item(1, { kind: "timed_role", role_id: "r1", duration_s: 7 * 86400 });
    const { fake } = await open({ items: [role], grantEnd });
    await fake.emit(fake.click("view:0", OWNER));
    await fake.emit(fake.click("buy", OWNER));
    const t = text(fake.lastPayload());
    expect(t).toContain("**Buy Item 1 for `500 🌱`?**");
    expect(t).toContain(
        `Your <@&r1> runs until <t:${ts("2026-01-13T00:00:00Z")}:D> - this moves it to <t:${ts("2026-01-20T00:00:00Z")}:D>. You keep \`750 🌱\`.`,
    );
    expect(t).toContain(`<t:${ts("2026-01-13T00:00:00Z")}:D>`);
    expect(t).toContain(`<t:${ts("2026-01-20T00:00:00Z")}:D>`);
    expect(t).toContain("You keep `750 🌱`");
});

test("confirm for a manual item has no delivery line", async () => {
    const { fake } = await open({ items: [item(1)] });
    await fake.emit(fake.click("view:0", OWNER));
    await fake.emit(fake.click("buy", OWNER));
    expect(text(fake.lastPayload())).toContain("**Buy Item 1 for `500 🌱`?**\nYou keep `750 🌱`.");
    expect(text(fake.lastPayload())).not.toContain("An admin will deliver it");
});

test("confirm for a fresh timed role says what you get and keep", async () => {
    const { fake } = await open({ items: [item(1, { kind: "timed_role", role_id: "r1", duration_s: 7 * 86400 })] });
    await fake.emit(fake.click("view:0", OWNER));
    await fake.emit(fake.click("buy", OWNER));
    expect(text(fake.lastPayload())).toContain("You get <@&r1> for 7 days and keep `750 🌱`.");
});

test("an ok manual purchase shows the Purchase ID and the delivery line", async () => {
    const bought = purchase(1, { code: "V8RJ3E", item_name: "Item 1" });
    const { fake, calls } = await open({ items: [item(1)], seeds: 500, outcome: { kind: "ok", purchase: bought, seedsLeft: 0 } });
    await fake.emit(fake.click("view:0", OWNER));
    await fake.emit(fake.click("buy", OWNER));
    await fake.emit(fake.click("confirm", OWNER));
    const t = text(fake.lastPayload());
    expect(t).toContain("**✅ You bought Item 1**");
    expect(t).toContain("Purchase ID `#V8RJ3E`");
    expect(t).toContain("An admin will deliver it. You have `0 🌱` left.");
    expect(labels(fake.lastPayload())).toEqual(expect.arrayContaining(["Back to shop", "My purchases"]));
    expect(buyCalls(calls)[0]?.[1]).toMatchObject({ guildId: GUILD, itemId: 1, userId: 7, buyerDiscordId: OWNER, expectedPrice: 500 });
});

test("an ok timed purchase says until when", async () => {
    const end = new Date("2026-01-17T00:00:00Z");
    const bought = purchase(1, { code: "V8RJ3E", kind: "timed_role", role_id: "r1", role_ends_at: end });
    const role = item(1, { kind: "timed_role", role_id: "r1", duration_s: 604800 });
    const { fake } = await open({ items: [role], outcome: { kind: "ok", purchase: bought, seedsLeft: 750 } });
    await fake.emit(fake.click("view:0", OWNER));
    await fake.emit(fake.click("buy", OWNER));
    await fake.emit(fake.click("confirm", OWNER));
    expect(text(fake.lastPayload())).toContain(`You have <@&r1> until <t:${ts("2026-01-17T00:00:00Z")}:D> and \`750 🌱\` left.`);
});

test("price_changed shows the new price and Buy then uses it", async () => {
    const { fake, calls, data } = await open({ items: [item(1)], seeds: 1250, outcome: { kind: "price_changed", price: 600 } });
    await fake.emit(fake.click("view:0", OWNER));
    await fake.emit(fake.click("buy", OWNER));
    await fake.emit(fake.click("confirm", OWNER));
    expect(text(fake.lastPayload())).toContain("**The price changed to `600 🌱`.**\nBuy Item 1 anyway? You keep `650 🌱`.");
    data.items = [item(1, { price: 600 })];
    await fake.emit(fake.click("confirm", OWNER));
    expect(buyCalls(calls).at(-1)?.[1]).toMatchObject({ expectedPrice: 600 });
});

test("role_failed notifies the exact line and goes back to the item", async () => {
    const role = item(1, { kind: "role", role_id: "r1" });
    const { fake } = await open({
        items: [role],
        outcome: { kind: "role_failed", purchase: purchase(1, { role_id: "r1", kind: "role" }) },
    });
    await fake.emit(fake.click("view:0", OWNER));
    await fake.emit(fake.click("buy", OWNER));
    await fake.emit(fake.click("confirm", OWNER));
    expect(fake.notifies.at(-1)?.content).toBe("The bot couldn't give you <@&r1>, so you weren't charged.");
    expect(button(fake.lastPayload(), "Buy")).toBeDefined();
});

for (const [outcome, line] of [
    [{ kind: "sold_out" }, "It just sold out."],
    [{ kind: "limit", max: 1 }, "You reached the limit for this item."],
    [{ kind: "short", short: 50 }, "You're `50 🌱` short."],
    [{ kind: "gone" }, "This item is no longer in the shop."],
    [{ kind: "closed" }, "The shop is closed."],
] as const) {
    test(`${outcome.kind} notifies a plain line`, async () => {
        const { fake } = await open({ items: [item(1)], outcome });
        await fake.emit(fake.click("view:0", OWNER));
        await fake.emit(fake.click("buy", OWNER));
        await fake.emit(fake.click("confirm", OWNER));
        expect(fake.notifies.at(-1)?.content).toBe(line);
    });
}

test("Buy refuses a role the member got since the card opened, without calling purchaseItem", async () => {
    const role = item(1, { kind: "role", role_id: "r1" });
    const { fake, calls, data } = await open({ items: [role], outcome: { kind: "closed" } });
    await fake.emit(fake.click("view:0", OWNER));
    await fake.emit(fake.click("buy", OWNER));
    data.holdsRole = true;
    await fake.emit(fake.click("confirm", OWNER));
    expect(fake.notifies.at(-1)?.content).toBe("You already have this role.");
    expect(buyCalls(calls)).toHaveLength(0);
    expect(button(fake.lastPayload(), "You have this role")?.disabled).toBe(true);
});

test("Buy with the economy off notifies the shop is closed and does not buy", async () => {
    const { fake, calls, data } = await open({ items: [item(1)] });
    await fake.emit(fake.click("view:0", OWNER));
    await fake.emit(fake.click("buy", OWNER));
    data.economyOn = false;
    await fake.emit(fake.click("confirm", OWNER));
    expect(fake.notifies.at(-1)?.content).toBe("The shop is closed.");
    expect(buyCalls(calls)).toHaveLength(0);
    expect(text(fake.lastPayload())).toContain("## Shop\nThe shop is closed.");
});

test("My purchases shows runs out for a future end and ran out for a past one", async () => {
    const future = purchase(1, {
        kind: "timed_role",
        role_id: "r1",
        status: "delivered",
        role_ends_at: new Date("2026-01-20T00:00:00Z"),
    });
    const past = purchase(2, { kind: "timed_role", role_id: "r1", status: "delivered", role_ends_at: new Date("2026-01-05T00:00:00Z") });
    const pending = purchase(3);
    const refunded = purchase(4, { status: "refunded", decided_at: new Date("2026-01-02T00:00:00Z") });
    const { fake } = await open({ purchases: [future, past, pending, refunded] });
    await fake.emit(fake.click("tab:purchases", OWNER));
    const t = text(fake.lastPayload());
    expect(t).toContain(`✅ Delivered · <@&r1> runs out <t:${ts("2026-01-20T00:00:00Z")}:R>`);
    expect(t).toContain(`✅ Delivered · <@&r1> ran out <t:${ts("2026-01-05T00:00:00Z")}:D>`);
    expect(t).toContain(`⏳ Pending · <t:${ts("2026-01-01T00:00:00Z")}:R>`);
    expect(t).toContain(`↩️ Refunded · <t:${ts("2026-01-02T00:00:00Z")}:R>`);
});

test("My purchases pages ten at a time", async () => {
    const purchases = Array.from({ length: 11 }, (_, i) => purchase(i + 1));
    const { fake } = await open({ purchases });
    await fake.emit(fake.click("tab:purchases", OWNER));
    expect(text(fake.lastPayload())).toContain("Thing 10");
    expect(text(fake.lastPayload())).not.toContain("Thing 11");
    await fake.emit(fake.click("next", OWNER));
    expect(text(fake.lastPayload())).toContain("Thing 11");
});
