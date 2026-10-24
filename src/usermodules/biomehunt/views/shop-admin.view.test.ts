import { expect, test } from "bun:test";
import { createFakeViewTransport, type ViewPayload } from "@/define";
import { PURCHASE_CODE_ALPHABET } from "../constants/shop.constants";
import type { ShopDeps } from "../services/shop.service";
import type { PurchaseRow, ShopItemRow } from "../types";
import { type ShopAdminDeps, shopAdminView } from "./shop-admin.view";

const OWNER = "owner";
const GUILD = "g1";

type Json = {
    custom_id?: string;
    label?: string;
    disabled?: boolean;
    style?: number;
    content?: string;
    components?: Json[];
    accessory?: Json;
    options?: { value: string; label: string; description?: string; default?: boolean }[];
    default_values?: { id: string }[];
    min_values?: number;
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
const component = (payload: ViewPayload, key: string) => flatten(payload).find((c) => c.custom_id?.endsWith(`:${key}`));
const button = (payload: ViewPayload, label: string) => flatten(payload).find((c) => c.label === label);

const ButtonDanger = 4;
const ButtonSuccess = 3;
const ButtonPrimary = 1;

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
    code: `K7Q2M${PURCHASE_CODE_ALPHABET[n]}`,
    guild_id: GUILD,
    item_id: 1,
    user_id: n,
    buyer_discord_id: `b${n}`,
    item_name: `Thing ${n}`,
    item_emoji: null,
    price: 100,
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
    created_at: new Date("2026-01-01T00:00:00Z"),
    ...over,
});

interface Setup {
    purchases?: PurchaseRow[];
    items?: ShopItemRow[];
    open?: boolean;
    economyOn?: boolean;
    pending?: number;
    pendingForItem?: number;
    roleProblem?: string | null;
}

function fakeDeps(setup: Setup = {}) {
    const calls: unknown[][] = [];
    const data = {
        items: [...(setup.items ?? [])],
        purchases: [...(setup.purchases ?? [])],
        open: setup.open ?? false,
        channel: null as string | null,
        nextId: 100,
        economyOn: setup.economyOn ?? true,
    };
    const deps: ShopAdminDeps = {
        guildId: GUILD,
        shop: {
            now: () => new Date("2026-01-03T00:00:00Z"),
            getPurchaseByCode: async (_g: string, code: string) => data.purchases.find((p) => p.code === code) ?? null,
        } as unknown as ShopDeps,
        listPurchases: async (_g, filter, offset, limit) => {
            calls.push(["listPurchases", filter, offset]);
            const all = data.purchases.filter((p) => filter === "all" || p.status === "pending");
            return { rows: all.slice(offset, offset + limit), total: all.length };
        },
        ensureShop: async () => ({ guild_id: GUILD, open: data.open, sales_channel_id: data.channel }),
        listLiveItems: async () => data.items,
        insertItem: async (_g, fields) => {
            calls.push(["insertItem", fields]);
            const row = { ...item(data.nextId++), ...fields };
            data.items = [...data.items, row];
            return row;
        },
        updateItem: async (_g, id, patch) => {
            calls.push(["updateItem", id, patch]);
            data.items = data.items.map((i) => (i.id === id ? { ...i, ...patch } : i));
            return data.items.find((i) => i.id === id) ?? null;
        },
        removeItem: async (_g, id) => {
            calls.push(["removeItem", id]);
            data.items = data.items.filter((i) => i.id !== id);
        },
        moveItem: async (_g, id, direction) => {
            calls.push(["moveItem", id, direction]);
            return false;
        },
        setShopOpen: async (_g, open) => {
            calls.push(["setShopOpen", open]);
            data.open = open;
        },
        setSalesChannel: async (_g, channelId) => {
            calls.push(["setSalesChannel", channelId]);
            data.channel = channelId;
        },
        countPending: async () => setup.pending ?? data.purchases.filter((p) => p.status === "pending").length,
        countPendingForItem: async () => setup.pendingForItem ?? 0,
        economyOn: async () => data.economyOn,
        checkRole: async (_g, roleId) => {
            calls.push(["checkRole", roleId]);
            return setup.roleProblem ?? null;
        },
    };
    return { deps, calls, data };
}

async function open(setup: Setup = {}) {
    const { deps, calls, data } = fakeDeps(setup);
    const fake = createFakeViewTransport();
    void fake.run(shopAdminView(deps), undefined, OWNER);
    await fake.flush();
    return { fake, calls, data };
}

type Fake = Awaited<ReturnType<typeof open>>["fake"];

/** Makes the next modal resolve with `values`. */
function answerModal(fake: Fake, values: Record<string, string>) {
    const ack = fake.modalSubmit(OWNER);
    fake.modalResult = async () => ({ values, ack });
}

const validForm = { name: "Cool role", description: "", price: "500", emoji: "", image: "" };

test("open shop shows the Close shop button, closed shows Open shop", async () => {
    const { fake } = await open({ open: true });
    expect(text(fake.lastPayload())).toContain("Open - members buy with `/bh shop`.");
    expect(button(fake.lastPayload(), "Close shop")?.style).toBe(ButtonDanger);
    await fake.emit(fake.click("toggle", OWNER));
    expect(text(fake.lastPayload())).toContain("Closed - only admins see it.");
    expect(button(fake.lastPayload(), "Open shop")?.style).toBe(ButtonSuccess);
});

test("the shop section has a Shop heading on its own line", async () => {
    const { fake } = await open({ open: true });
    expect(text(fake.lastPayload())).toContain("**Shop**\nOpen - members buy with `/bh shop`.");
});

test("a role item with no role picked says so in the list and the editor", async () => {
    const { fake } = await open({ items: [item(1, { kind: "role", role_id: null })] });
    expect(text(fake.lastPayload())).toContain("⚠️ No role picked");
    await fake.emit(fake.click("edit:0", OWNER));
    expect(text(fake.lastPayload())).toContain("⚠️ No role picked");
});

test("the Add item and Limits forms use the short titles, labels and an 11 character price", async () => {
    const added = await open();
    answerModal(added.fake, validForm);
    await added.fake.emit(added.fake.click("add", OWNER));
    expect(added.fake.modals[0].spec.title).toBe("New item");
    expect(added.fake.modals[0].spec.fields.find((f) => f.key === "price")?.maxLength).toBe(11);
    const { fake } = await open({ items: [item(1, { name: "A".repeat(60), stock: 5 })] });
    await fake.emit(fake.click("edit:0", OWNER));
    answerModal(fake, { stock: "5", max: "" });
    await fake.emit(fake.click("limits", OWNER));
    const limits = fake.modals.at(-1)?.spec;
    expect(limits?.title).toBe(`${"A".repeat(60)} limits`.slice(0, 45));
    expect(limits?.fields.map((f) => f.label)).toEqual(["Stock", "Max per member"]);
});

test("the economy-off block shows only when the economy is off", async () => {
    const off = await open({ economyOn: false });
    expect(text(off.fake.lastPayload())).toContain("The economy is off");
    expect(text(off.fake.lastPayload())).toContain("EXPERIMENT_BIOME_ECONOMY");
    const on = await open({ economyOn: true });
    expect(text(on.fake.lastPayload())).not.toContain("The economy is off");
});

test("an empty shop says so", async () => {
    const { fake } = await open();
    expect(text(fake.lastPayload())).toContain("No items yet.");
});

test("the Purchases tab shows the pending count only when above zero", async () => {
    expect(labels((await open({ pending: 3 })).fake.lastPayload())).toContain("Purchases · 3");
    const none = labels((await open({ pending: 0 })).fake.lastPayload());
    expect(none).toContain("Purchases");
    expect(none).not.toContain("Purchases · 0");
});

test("the list describes each item and pages hold five", async () => {
    const items = [
        item(1, { emoji: "🎁", price: 1250, stock: 12, max_per_member: 1 }),
        item(2, { kind: "timed_role", role_id: "r1", duration_s: 604800, stock: 0 }),
        item(3, { kind: "role", role_id: "r2" }),
        item(4),
        item(5),
        item(6),
    ];
    const { fake } = await open({ items });
    const t = text(fake.lastPayload());
    expect(t).toContain("🎁 **Item 1** · `1,250 🌱`\n-# Delivered by hand · 12 left · 1 per member");
    expect(t).toContain("-# Role <@&r1> for 7 days · Sold out");
    expect(t).toContain("-# Role <@&r2>");
    expect(t).not.toContain("Item 6");
    expect(labels(fake.lastPayload())).toContain("1 / 2");
});

test("Add item is disabled with 25 live items", async () => {
    const full = await open({ items: Array.from({ length: 25 }, (_, i) => item(i + 1)) });
    expect(button(full.fake.lastPayload(), "Add item")?.disabled).toBe(true);
    const some = await open({ items: [item(1)] });
    expect(button(some.fake.lastPayload(), "Add item")?.disabled).toBe(false);
    expect(button(some.fake.lastPayload(), "Add item")?.style).toBe(ButtonSuccess);
});

test("a bad price in the Add item form notifies and inserts nothing", async () => {
    const { fake, calls } = await open();
    answerModal(fake, { ...validForm, price: "abc" });
    await fake.emit(fake.click("add", OWNER));
    expect(fake.notifies.at(-1)?.content).toContain("whole number from 0 to 999,999,999");
    expect(calls.some((c) => c[0] === "insertItem")).toBe(false);
    expect(text(fake.lastPayload())).toContain("No items yet.");
});

test("a bad image URL and a bad emoji notify and insert nothing", async () => {
    const { fake, calls } = await open();
    answerModal(fake, { ...validForm, image: "http://x.png" });
    await fake.emit(fake.click("add", OWNER));
    expect(fake.notifies.at(-1)?.content).toContain("https://");
    answerModal(fake, { ...validForm, emoji: "two words" });
    await fake.emit(fake.click("add", OWNER));
    expect(fake.notifies.at(-1)?.content).toContain("emoji");
    expect(calls.some((c) => c[0] === "insertItem")).toBe(false);
});

test.each([
    ["999.999.999", 999_999_999],
    ["999,999,999", 999_999_999],
    ["1 250", 1250],
    ["0", 0],
])("the price %p is read as %p", async (typed, price) => {
    const { fake, calls } = await open();
    answerModal(fake, { ...validForm, price: typed });
    await fake.emit(fake.click("add", OWNER));
    expect(calls.find((c) => c[0] === "insertItem")?.[1]).toMatchObject({ price });
});

test.each(["1.5", "1,50", "1000000000"])("the price %p is refused", async (typed) => {
    const { fake, calls } = await open();
    answerModal(fake, { ...validForm, price: typed });
    await fake.emit(fake.click("add", OWNER));
    expect(fake.notifies.at(-1)?.content).toContain("whole number from 0 to 999,999,999");
    expect(calls.some((c) => c[0] === "insertItem")).toBe(false);
});

test("a valid Add item form inserts a manual item and opens its editor", async () => {
    const { fake, calls } = await open();
    answerModal(fake, { ...validForm, price: "1,500", emoji: "🎁" });
    await fake.emit(fake.click("add", OWNER));
    expect(calls.find((c) => c[0] === "insertItem")?.[1]).toMatchObject({
        name: "Cool role",
        price: 1500,
        emoji: "🎁",
        kind: "manual",
        role_id: null,
        duration_s: null,
    });
    const t = text(fake.lastPayload());
    expect(t).toContain("## 🎁 Cool role");
    expect(t).toContain("**Gives**");
});

test("the Gives select lists the three options and saves on change", async () => {
    const { fake, calls } = await open({ items: [item(1)] });
    await fake.emit(fake.click("edit:0", OWNER));
    const gives = component(fake.lastPayload(), "gives");
    expect(gives?.options?.map((o) => o.label)).toEqual(["Nothing - delivered by hand", "A role", "A role for a while"]);
    expect(gives?.options?.[0].description).toBe("Stays Pending until an admin marks it delivered");
    expect(component(fake.lastPayload(), "role")).toBeUndefined();

    await fake.emit(fake.click("gives", OWNER, ["timed_role"]));
    expect(calls.find((c) => c[0] === "updateItem")?.[2]).toEqual({ kind: "timed_role", duration_s: 604800 });
    expect(component(fake.lastPayload(), "role")).toBeDefined();
    expect(component(fake.lastPayload(), "duration")?.options?.find((o) => o.default)?.value).toBe("604800");

    await fake.emit(fake.click("gives", OWNER, ["manual"]));
    expect(calls.filter((c) => c[0] === "updateItem").at(-1)?.[2]).toEqual({ kind: "manual", role_id: null, duration_s: null });
});

test("picking a role saves it and shows the warning when the bot can't give it", async () => {
    const { fake, calls } = await open({
        items: [item(1, { kind: "role" })],
        roleProblem: "⚠️ The bot can't give <@&r9> - move the bot's role above it.",
    });
    await fake.emit(fake.click("edit:0", OWNER));
    expect(text(fake.lastPayload())).not.toContain("The bot can't give");
    await fake.emit(fake.click("role", OWNER, ["r9"]));
    expect(calls.find((c) => c[0] === "updateItem")?.[2]).toEqual({ role_id: "r9" });
    expect(text(fake.lastPayload())).toContain("⚠️ The bot can't give <@&r9>");
});

test("the role is re-checked when the editor opens", async () => {
    const { fake, calls } = await open({ items: [item(1, { kind: "role", role_id: "r1" })], roleProblem: "⚠️ That role no longer exists." });
    await fake.emit(fake.click("edit:0", OWNER));
    expect(calls).toContainEqual(["checkRole", "r1"]);
    expect(text(fake.lastPayload())).toContain("⚠️ That role no longer exists.");
});

test("the duration select saves a preset and parses Other…", async () => {
    const { fake, calls } = await open({ items: [item(1, { kind: "timed_role", role_id: "r1", duration_s: 604800 })] });
    await fake.emit(fake.click("edit:0", OWNER));
    const options = component(fake.lastPayload(), "duration")?.options;
    expect(options?.map((o) => o.label)).toEqual(["For 1 day", "For 3 days", "For 7 days", "For 14 days", "For 30 days", "Other…"]);
    await fake.emit(fake.click("duration", OWNER, [String(3 * 86400)]));
    expect(calls.filter((c) => c[0] === "updateItem").at(-1)?.[2]).toEqual({ duration_s: 259200 });

    answerModal(fake, { duration: "1d12h" });
    await fake.emit(fake.click("duration", OWNER, ["other"]));
    expect(calls.filter((c) => c[0] === "updateItem").at(-1)?.[2]).toEqual({ duration_s: 129600 });

    const before = calls.filter((c) => c[0] === "updateItem").length;
    answerModal(fake, { duration: "soon" });
    await fake.emit(fake.click("duration", OWNER, ["other"]));
    expect(fake.notifies.at(-1)?.content).toContain("not a duration");
    expect(calls.filter((c) => c[0] === "updateItem").length).toBe(before);
});

test("the Limits form saves numbers, empty means unlimited, bad values notify", async () => {
    const { fake, calls } = await open({ items: [item(1, { stock: 5 })] });
    await fake.emit(fake.click("edit:0", OWNER));
    answerModal(fake, { stock: "", max: "2" });
    await fake.emit(fake.click("limits", OWNER));
    expect(calls.find((c) => c[0] === "updateItem")?.[2]).toEqual({ stock: null, max_per_member: 2 });

    const before = calls.length;
    answerModal(fake, { stock: "5", max: "0" });
    await fake.emit(fake.click("limits", OWNER));
    expect(fake.notifies.at(-1)?.content).toContain("Max per member");
    expect(calls.length).toBe(before);
});

test("Move up on the first item is a no-op without an error", async () => {
    const { fake, calls } = await open({ items: [item(1), item(2)] });
    await fake.emit(fake.click("edit:0", OWNER));
    expect(button(fake.lastPayload(), "Move up")?.disabled).toBe(true);
    await fake.emit(fake.click("up", OWNER));
    expect(fake.notifies.length).toBe(0);
    expect(text(fake.lastPayload())).toContain("## Item 1");
    expect(calls.filter((c) => c[0] === "moveItem").length).toBe(1);
});

test("Remove asks first, mentions pending purchases only when there are any, and removes on confirm", async () => {
    const withPending = await open({ items: [item(1)], pendingForItem: 2 });
    await withPending.fake.emit(withPending.fake.click("edit:0", OWNER));
    await withPending.fake.emit(withPending.fake.click("remove", OWNER));
    expect(text(withPending.fake.lastPayload())).toContain("**Remove Item 1 from the shop?**");
    expect(text(withPending.fake.lastPayload())).toContain("-# Its 2 pending purchases stay in Purchases.");
    expect(withPending.calls.some((c) => c[0] === "removeItem")).toBe(false);
    expect(button(withPending.fake.lastPayload(), "Remove")?.style).toBe(ButtonDanger);
    await withPending.fake.emit(withPending.fake.click("no", OWNER));
    expect(withPending.calls.some((c) => c[0] === "removeItem")).toBe(false);

    const none = await open({ items: [item(1)], pendingForItem: 0 });
    await none.fake.emit(none.fake.click("edit:0", OWNER));
    await none.fake.emit(none.fake.click("remove", OWNER));
    expect(text(none.fake.lastPayload())).not.toContain("pending");
    await none.fake.emit(none.fake.click("yes", OWNER));
    expect(none.calls).toContainEqual(["removeItem", 1]);
    expect(text(none.fake.lastPayload())).toContain("No items yet.");
});

test("Edit details is prefilled and saves", async () => {
    const { fake, calls } = await open({ items: [item(1, { description: "Old" })] });
    await fake.emit(fake.click("edit:0", OWNER));
    expect(button(fake.lastPayload(), "Edit details")?.style).toBe(ButtonPrimary);
    answerModal(fake, { ...validForm, name: "New name", description: "New" });
    await fake.emit(fake.click("details", OWNER));
    expect(fake.modals[0].spec.fields.find((f) => f.key === "name")?.value).toBe("Item 1");
    expect(calls.find((c) => c[0] === "updateItem")?.[2]).toMatchObject({ name: "New name", description: "New", price: 500 });
});

test("the Settings channel select saves on change and can be cleared", async () => {
    const { fake, calls } = await open();
    await fake.emit(fake.click("tab:settings", OWNER));
    expect(text(fake.lastPayload())).toContain("**Sales channel**\nEvery purchase is posted here.");
    expect(component(fake.lastPayload(), "salesChannel")?.min_values).toBe(0);
    await fake.emit(fake.click("salesChannel", OWNER, ["c1"]));
    expect(calls).toContainEqual(["setSalesChannel", "c1"]);
    expect(component(fake.lastPayload(), "salesChannel")?.default_values?.[0]?.id).toBe("c1");
    await fake.emit(fake.click("salesChannel", OWNER, []));
    expect(calls).toContainEqual(["setSalesChannel", null]);
});

const codeOf = (n: number) => purchase(n).code;

test("Purchases starts on Pending when something is pending, on All otherwise", async () => {
    const pending = await open({ purchases: [purchase(1), purchase(2, { status: "delivered" })] });
    await pending.fake.emit(pending.fake.click("tab:purchases", OWNER));
    const t = text(pending.fake.lastPayload());
    expect(t).toContain("**Purchases**");
    expect(t).toContain(`\`#${codeOf(1)}\` · **Thing 1** · <@b1>\n-# ⏳ Pending · <t:1767225600:R>`);
    expect(t).not.toContain("Thing 2");
    expect(component(pending.fake.lastPayload(), "filter")?.options?.find((o) => o.default)?.label).toBe("Pending");

    const none = await open({ purchases: [purchase(2, { status: "delivered" })] });
    await none.fake.emit(none.fake.click("tab:purchases", OWNER));
    expect(text(none.fake.lastPayload())).toContain("Thing 2");
    expect(component(none.fake.lastPayload(), "filter")?.options?.find((o) => o.default)?.label).toBe("All");
});

test("Purchases lays out the list, page row, filter, tabs, then Find ID / Close", async () => {
    const { fake } = await open({ purchases: Array.from({ length: 12 }, (_, i) => purchase(i + 1)) });
    await fake.emit(fake.click("tab:purchases", OWNER));
    const tops = (fake.lastPayload().components as unknown as Array<{ toJSON(): Json }>).map((c) => c.toJSON());
    const ids = (node: Json) =>
        JSON.stringify(node)
            .match(/"custom_id":"[^"]*:([^":]+)"/g)
            ?.map((m) => m.split(":").at(-1)?.replace('"', "")) ?? [];
    expect(JSON.stringify(tops[0])).toContain(":open");
    expect(JSON.stringify(tops[0])).not.toContain(":filter");
    const rest = tops.slice(1).map((t) => ids(t));
    const at = (key: string) => rest.findIndex((r) => r.includes(key));
    expect(at("next")).toBeGreaterThanOrEqual(0);
    expect(at("next")).toBeLessThan(at("filter"));
    expect(at("filter")).toBeLessThan(at("items"));
    expect(at("items")).toBeLessThan(at("find"));
});

test("empty lists say so", async () => {
    const none = await open();
    await none.fake.emit(none.fake.click("tab:purchases", OWNER));
    expect(text(none.fake.lastPayload())).toContain("No purchases yet.");
    expect(component(none.fake.lastPayload(), "open")).toBeUndefined();
    const done = await open({ purchases: [purchase(1, { status: "delivered" })] });
    await done.fake.emit(done.fake.click("tab:purchases", OWNER));
    await done.fake.emit(done.fake.click("filter", OWNER, ["pending"]));
    expect(text(done.fake.lastPayload())).toContain("Nothing pending.");
});

test("status lines for delivered and refunded purchases", async () => {
    const at = new Date("2026-01-02T00:00:00Z");
    const { fake } = await open({
        purchases: [
            purchase(1, { kind: "timed_role", role_id: "r1", role_ends_at: new Date("2026-01-09T00:00:00Z"), status: "delivered" }),
            purchase(2, { kind: "role", role_id: "r1", status: "delivered", decided_at: at }),
            purchase(3, { status: "refunded", decided_by: "adm", decided_at: at }),
        ],
    });
    await fake.emit(fake.click("tab:purchases", OWNER));
    const t = text(fake.lastPayload());
    expect(t).toContain("-# ✅ Delivered · <@&r1> until <t:1767916800:D>");
    expect(t).toContain("-# ✅ Delivered · <t:1767312000:R>");
    expect(t).toContain("-# ↩️ Refunded by <@adm> · <t:1767312000:R>");
});

test("switching the filter resets to page 0 and reloads", async () => {
    const many = Array.from({ length: 12 }, (_, i) => purchase(i + 1, i < 3 ? {} : { status: "delivered" }));
    const { fake, calls } = await open({ purchases: many });
    await fake.emit(fake.click("tab:purchases", OWNER));
    await fake.emit(fake.click("filter", OWNER, ["all"]));
    await fake.emit(fake.click("next", OWNER));
    expect(labels(fake.lastPayload())).toContain("2 / 2");
    await fake.emit(fake.click("filter", OWNER, ["pending"]));
    expect(calls.filter((c) => c[0] === "listPurchases").at(-1)).toEqual(["listPurchases", "pending", 0]);
    expect(labels(fake.lastPayload())).not.toContain("2 / 2");
    expect(text(fake.lastPayload())).toContain("Thing 1");
});

test("12 purchases show a page row and page 2 lists 2", async () => {
    const many = Array.from({ length: 12 }, (_, i) => purchase(i + 1));
    const { fake } = await open({ purchases: many });
    await fake.emit(fake.click("tab:purchases", OWNER));
    expect(labels(fake.lastPayload())).toContain("1 / 2");
    expect(component(fake.lastPayload(), "open")?.options?.length).toBe(10);
    await fake.emit(fake.click("next", OWNER));
    expect(text(fake.lastPayload()).match(/⏳ Pending/g)?.length).toBe(2);
    expect(component(fake.lastPayload(), "open")?.options?.length).toBe(2);
});

test("the open select lists '#CODE · name' and opens the card", async () => {
    const { fake } = await open({ purchases: [purchase(1)] });
    await fake.emit(fake.click("tab:purchases", OWNER));
    expect(component(fake.lastPayload(), "open")?.options?.[0].label).toBe(`#${codeOf(1)} · Thing 1`);
    await fake.emit(fake.click("open", OWNER, [codeOf(1)]));
    expect(text(fake.lastPayload())).toContain("Bought by <@b1>");
    expect(button(fake.lastPayload(), "Back")).toBeDefined();
});

test("Find ID opens the card for a lowercase code", async () => {
    const { fake } = await open({ purchases: [purchase(1)] });
    await fake.emit(fake.click("tab:purchases", OWNER));
    expect(button(fake.lastPayload(), "Find ID")?.style).toBe(ButtonPrimary);
    answerModal(fake, { id: ` #${codeOf(1).toLowerCase()}` });
    await fake.emit(fake.click("find", OWNER));
    expect(fake.modals[0].spec.title).toBe("Find a purchase");
    expect(fake.modals[0].spec.fields[0].label).toBe("Purchase ID");
    expect(text(fake.lastPayload())).toContain(`#${codeOf(1)}`);
    expect(text(fake.lastPayload())).toContain("Bought by <@b1>");
});

test("an unknown or malformed ID notifies and opens nothing", async () => {
    const { fake } = await open({ purchases: [purchase(1)] });
    await fake.emit(fake.click("tab:purchases", OWNER));
    answerModal(fake, { id: "zzzzzz" });
    await fake.emit(fake.click("find", OWNER));
    expect(fake.notifies.at(-1)?.content).toBe("No purchase with ID `#ZZZZZZ`.");
    answerModal(fake, { id: "#ab" });
    await fake.emit(fake.click("find", OWNER));
    expect(fake.notifies.at(-1)?.content).toBe("No purchase with ID `#AB`.");
    expect(text(fake.lastPayload())).toContain("**Purchases**");
});

test("a purchase keeps its snapshot name", async () => {
    const { fake } = await open({
        items: [item(1, { name: "Renamed" })],
        purchases: [purchase(1, { item_name: "Old name", item_emoji: "🎁" })],
    });
    await fake.emit(fake.click("tab:purchases", OWNER));
    expect(text(fake.lastPayload())).toContain("🎁 **Old name**");
});

test("switching tabs reloads the pending count and the economy flag", async () => {
    const { fake, data } = await open({ purchases: [purchase(1)] });
    data.purchases = [purchase(1), purchase(2)];
    data.economyOn = false;
    await fake.emit(fake.click("tab:settings", OWNER));
    expect(labels(fake.lastPayload())).toContain("Purchases · 2");
    await fake.emit(fake.click("tab:items", OWNER));
    expect(text(fake.lastPayload())).toContain("The economy is off");
    data.economyOn = true;
    await fake.emit(fake.click("tab:settings", OWNER));
    await fake.emit(fake.click("tab:items", OWNER));
    expect(text(fake.lastPayload())).not.toContain("The economy is off");
});
