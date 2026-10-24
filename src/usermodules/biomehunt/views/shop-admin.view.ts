import { ButtonStyle } from "discord.js";
import { confirm, defineView, type HandlerContext, paginationHandlers, type ViewDefinition } from "@/define";
import { EmbedFormatter } from "@/utils/format";
import {
    ITEM_DESCRIPTION_MAX,
    ITEM_NAME_MAX,
    MAX_ITEM_PRICE,
    MAX_SHOP_ITEMS,
    normalizePurchaseCode,
    PURCHASES_PER_PAGE,
    parseRoleDuration,
    SHOP_ITEMS_PER_PAGE,
} from "../constants/shop.constants";
import type { countPending, countPendingForItem, listPurchases } from "../repository/purchases.repository";
import type {
    ensureShop,
    insertItem,
    listLiveItems,
    moveItem,
    removeItem,
    setSalesChannel,
    setShopOpen,
    updateItem,
} from "../repository/shop.repository";
import { parseBadgeEmoji, parseIconUrl } from "../services/biome-admin.service";
import type { ShopDeps } from "../services/shop.service";
import { BiomeHuntError, type PurchaseRow, type ShopItemFields, type ShopItemRow, type ShopRow } from "../types";
import { DEFAULT_TIMED_DURATION_S, purchasePages, renderShopAdmin, shopItemPages } from "./shop-admin.screens";
import { purchaseCardView } from "./shop-purchase.view";

const RED = 0xda373c;

/** What the View needs that would otherwise be a DB/Discord call, injected so its tests never hit any of them. */
export interface ShopAdminDeps {
    guildId: string;
    /** The purchase flows' deps; the Purchases tab opens the purchase card with them. */
    shop: ShopDeps;
    ensureShop: typeof ensureShop;
    listLiveItems: typeof listLiveItems;
    insertItem: typeof insertItem;
    updateItem: typeof updateItem;
    removeItem: typeof removeItem;
    moveItem: typeof moveItem;
    setShopOpen: typeof setShopOpen;
    setSalesChannel: typeof setSalesChannel;
    listPurchases: typeof listPurchases;
    countPending: typeof countPending;
    countPendingForItem: typeof countPendingForItem;
    economyOn(guildId: string): Promise<boolean>;
    /** The warning line for a role the bot can't give, or null when it can. */
    checkRole(guildId: string, roleId: string): Promise<string | null>;
}

export type ShopAdminScreen = "items" | "editor" | "purchases" | "settings";

export interface ShopAdminState {
    screen: ShopAdminScreen;
    page: number;
    /** The item in the editor. */
    itemId: number | null;
    shop: ShopRow;
    items: ShopItemRow[];
    pending: number;
    economyOn: boolean;
    roleIssue: string | null;
    /** The Purchases tab: which purchases, and the current page of them (`page` is shared with Items). */
    filter: "pending" | "all";
    purchases: PurchaseRow[];
    purchaseTotal: number;
}

type Ctx = HandlerContext<ShopAdminState, void>;

const isRoleKind = (kind: ShopItemRow["kind"]) => kind === "role" || kind === "timed_role";

/** The Add item and Edit details form; `item` prefills it. */
function detailsFields(item?: ShopItemRow) {
    return [
        { key: "name", label: "Name", value: item?.name, required: true, maxLength: ITEM_NAME_MAX },
        {
            key: "description",
            label: "Description",
            style: "paragraph" as const,
            value: item?.description ?? undefined,
            required: false,
            maxLength: ITEM_DESCRIPTION_MAX,
        },
        { key: "price", label: "Price in Seeds", value: item ? String(item.price) : undefined, required: true, maxLength: 7 },
        { key: "emoji", label: "Emoji", value: item?.emoji ?? undefined, required: false },
        { key: "image", label: "Image URL, https://", value: item?.image_url ?? undefined, required: false },
    ];
}

/** Reads the details form; throws a `BiomeHuntError` naming the first bad value. */
function parseDetails(values: Record<string, string>): Pick<ShopItemFields, "name" | "description" | "emoji" | "image_url" | "price"> {
    const name = (values.name ?? "").trim();
    if (!name || name.length > ITEM_NAME_MAX) throw new BiomeHuntError(`The name must be 1 to ${ITEM_NAME_MAX} characters.`);
    const description = (values.description ?? "").trim();
    if (description.length > ITEM_DESCRIPTION_MAX)
        throw new BiomeHuntError(`The description can have up to ${ITEM_DESCRIPTION_MAX} characters.`);
    const rawPrice = (values.price ?? "").replace(/[,\s]/g, "");
    const price = Number(rawPrice);
    if (!/^\d+$/.test(rawPrice) || price > MAX_ITEM_PRICE)
        throw new BiomeHuntError(`The price must be a whole number from 0 to ${MAX_ITEM_PRICE.toLocaleString("en-US")}.`);
    const emoji = (values.emoji ?? "").trim();
    const image = (values.image ?? "").trim();
    try {
        return {
            name,
            description: description || null,
            price,
            emoji: emoji ? parseBadgeEmoji(emoji) : null,
            image_url: image ? parseIconUrl(image) : null,
        };
    } catch (err) {
        if (!(err instanceof BiomeHuntError)) throw err;
        throw new BiomeHuntError(err.message.replace("The badge emoji", "The emoji").replace("The icon", "The image"));
    }
}

/** A blank field is "no value"; otherwise a whole number of at least `min`. */
function parseLimit(raw: string, label: string, min: number): number | null {
    const text = raw.trim();
    if (!text) return null;
    if (!/^\d+$/.test(text) || Number(text) < min) throw new BiomeHuntError(`${label} must be a whole number of ${min} or more, or empty.`);
    return Number(text);
}

/**
 * `/admin shop`: the Items tab (list, open/close, editor with Gives/role/duration selects that save
 * on change, limits, order, remove) and the Settings tab (sales channel).
 */
export function shopAdminView(deps: ShopAdminDeps): ViewDefinition<ShopAdminState, void, void> {
    const { guildId } = deps;

    const selected = (s: ShopAdminState) => s.items.find((i) => i.id === s.itemId);

    const pagesOf = (s: ShopAdminState) => (s.screen === "purchases" ? purchasePages(s) : shopItemPages(s));

    /** Re-reads the current page of purchases for the filter; steps back a page when the list shrank. */
    async function loadPurchases(s: ShopAdminState): Promise<void> {
        let res = await deps.listPurchases(guildId, s.filter, s.page * PURCHASES_PER_PAGE, PURCHASES_PER_PAGE);
        const last = Math.max(0, Math.ceil(res.total / PURCHASES_PER_PAGE) - 1);
        if (s.page > last) {
            s.page = last;
            res = await deps.listPurchases(guildId, s.filter, s.page * PURCHASES_PER_PAGE, PURCHASES_PER_PAGE);
        }
        Object.assign(s, { purchases: res.rows, purchaseTotal: res.total });
    }

    /** Re-reads the shop, its items and the pending count; re-checks the selected item's role. */
    async function reload(s: ShopAdminState): Promise<void> {
        const [shop, items, pending, economyOn] = await Promise.all([
            deps.ensureShop(guildId),
            deps.listLiveItems(guildId),
            deps.countPending(guildId),
            deps.economyOn(guildId),
        ]);
        Object.assign(s, { shop, items, pending, economyOn });
        if (s.screen === "purchases") await loadPurchases(s);
        else s.page = Math.min(s.page, shopItemPages(s) - 1);
        if (s.screen === "editor" && !selected(s)) s.screen = "items";
        const item = selected(s);
        s.roleIssue = item && isRoleKind(item.kind) && item.role_id ? await deps.checkRole(guildId, item.role_id) : null;
    }

    /** Runs a form parser; tells the admin what is wrong and returns null when it throws. */
    async function parsed<T>(c: Ctx, parse: () => T): Promise<T | null> {
        try {
            return parse();
        } catch (err) {
            if (!(err instanceof BiomeHuntError)) throw err;
            await c.notify(err.message);
            return null;
        }
    }

    async function save(c: Ctx, patch: Partial<ShopItemFields>): Promise<void> {
        const item = selected(c.state);
        if (!item) return;
        await deps.updateItem(guildId, item.id, patch);
        await reload(c.state);
    }

    const add = async (c: Ctx) => {
        const values = await c.modal({ title: "Add item", fields: detailsFields() });
        if (!values) return;
        const details = await parsed(c, () => parseDetails(values));
        if (!details) return;
        if ((await deps.listLiveItems(guildId)).length >= MAX_SHOP_ITEMS) {
            await c.notify(`A shop holds up to ${MAX_SHOP_ITEMS} items.`);
            return;
        }
        const item = await deps.insertItem(guildId, {
            ...details,
            kind: "manual",
            role_id: null,
            duration_s: null,
            stock: null,
            max_per_member: null,
        });
        c.state.itemId = item.id;
        c.state.screen = "editor";
        await reload(c.state);
    };

    const details = async (c: Ctx) => {
        const item = selected(c.state);
        if (!item) return;
        const values = await c.modal({ title: "Edit details", fields: detailsFields(item) });
        if (!values) return;
        const patch = await parsed(c, () => parseDetails(values));
        if (patch) await save(c, patch);
    };

    const limits = async (c: Ctx) => {
        const item = selected(c.state);
        if (!item) return;
        const values = await c.modal({
            title: "Limits",
            fields: [
                {
                    key: "stock",
                    label: "Stock (empty = unlimited)",
                    value: item.stock === null ? undefined : String(item.stock),
                    required: false,
                },
                {
                    key: "max",
                    label: "Max per member (empty = no limit)",
                    value: item.max_per_member === null ? undefined : String(item.max_per_member),
                    required: false,
                },
            ],
        });
        if (!values) return;
        const patch = await parsed(c, () => ({
            stock: parseLimit(values.stock ?? "", "Stock", 0),
            max_per_member: parseLimit(values.max ?? "", "Max per member", 1),
        }));
        if (patch) await save(c, patch);
    };

    const gives = async (c: Ctx) => {
        const kind = c.values[0] as ShopItemRow["kind"] | undefined;
        const item = selected(c.state);
        if (!item || !kind || kind === item.kind) return;
        if (kind === "manual") await save(c, { kind, role_id: null, duration_s: null });
        else if (kind === "role") await save(c, { kind, duration_s: null });
        else await save(c, { kind, duration_s: item.duration_s ?? DEFAULT_TIMED_DURATION_S });
    };

    const duration = async (c: Ctx) => {
        const value = c.values[0];
        if (!value) return;
        if (value !== "other") {
            await save(c, { duration_s: Number(value) });
            return;
        }
        const values = await c.modal({
            title: "Duration",
            fields: [{ key: "duration", label: "Duration, e.g. 10d or 12h", required: true, maxLength: 20 }],
        });
        if (!values) return;
        const seconds = await parsed(c, () => parseRoleDuration(values.duration ?? ""));
        if (seconds !== null) await save(c, { duration_s: seconds });
    };

    const move = (direction: "up" | "down") => async (c: Ctx) => {
        const item = selected(c.state);
        if (!item) return;
        await deps.moveItem(guildId, item.id, direction);
        await reload(c.state);
    };

    const remove = async (c: Ctx) => {
        const item = selected(c.state);
        if (!item) return;
        const pending = await deps.countPendingForItem(item.id);
        const removed = await c.open(
            confirm({
                name: "biomehunt.shop-remove",
                title: `Remove ${item.name} from the shop?`,
                body: pending > 0 ? `-# Its ${pending} pending ${pending === 1 ? "purchase stays" : "purchases stay"} in Purchases.` : "",
                color: RED,
                confirmLabel: "Remove",
                confirmStyle: ButtonStyle.Danger,
                cancelStyle: ButtonStyle.Secondary,
                onConfirm: async () => {
                    await deps.removeItem(guildId, item.id);
                    return EmbedFormatter.success(`${item.name} was removed.`);
                },
            }),
            undefined,
        );
        if (!removed) return;
        c.state.screen = "items";
        c.state.itemId = null;
        await reload(c.state);
    };

    /** Switches tab from page 0 and re-reads, so the pending count and economy flag are fresh. */
    const tab = (screen: ShopAdminScreen) => async (c: Ctx) => {
        Object.assign(c.state, { screen, page: 0 });
        await reload(c.state);
    };

    /** Opens the purchase card, then refreshes the list: the admin may have decided it. */
    async function openPurchase(c: Ctx, code: string): Promise<void> {
        await c.open(purchaseCardView(deps.shop), { guildId, code, fromMenu: true });
        await reload(c.state);
    }

    const find = async (c: Ctx) => {
        const values = await c.modal({
            title: "Find a purchase",
            fields: [{ key: "id", label: "Purchase ID", required: true, maxLength: 12 }],
        });
        if (!values) return;
        const typed = (values.id ?? "").trim().replace(/^#/, "").toUpperCase();
        const code = normalizePurchaseCode(typed);
        if (!code || !(await deps.shop.getPurchaseByCode(guildId, code))) {
            await c.notify(`No purchase with ID \`#${typed}\`.`);
            return;
        }
        await openPurchase(c, code);
    };

    /** The shared pagination handlers, re-reading the purchases after a page change. */
    const paging = paginationHandlers<ShopAdminState>({ pages: pagesOf });
    const paged = Object.fromEntries(
        Object.entries(paging).map(([key, handler]) => [
            key,
            async (c: Ctx) => {
                await handler(c);
                if (c.state.screen === "purchases") await loadPurchases(c.state);
            },
        ]),
    );

    return defineView<ShopAdminState, void, void>({
        name: "biomehunt.shop-admin",
        initial: async () => {
            const state = {
                screen: "items",
                page: 0,
                itemId: null,
                pending: 0,
                economyOn: true,
                roleIssue: null,
                filter: "all" as ShopAdminState["filter"],
                purchases: [],
                purchaseTotal: 0,
                items: [],
                shop: { guild_id: guildId, open: false, sales_channel_id: null },
            } satisfies ShopAdminState;
            await reload(state);
            state.filter = state.pending > 0 ? "pending" : "all";
            return state;
        },
        render: renderShopAdmin,
        on: {
            ...paged,
            "tab:items": tab("items"),
            "tab:purchases": tab("purchases"),
            "tab:settings": tab("settings"),
            find,
            filter: async (c) => {
                c.state.filter = c.values[0] === "all" ? "all" : "pending";
                c.state.page = 0;
                await loadPurchases(c.state);
            },
            open: async (c) => {
                const code = c.values[0];
                if (code) await openPurchase(c, code);
            },
            ...Object.fromEntries(
                Array.from({ length: SHOP_ITEMS_PER_PAGE }, (_, slot) => [
                    `edit:${slot}`,
                    async (c: Ctx) => {
                        const item = c.state.items[c.state.page * SHOP_ITEMS_PER_PAGE + slot];
                        if (!item) return;
                        Object.assign(c.state, { itemId: item.id, screen: "editor" });
                        // The bot's access to the role can change between visits.
                        await reload(c.state);
                    },
                ]),
            ),
            close: (c) => c.done(),
            back: (c) => {
                c.state.screen = "items";
                c.state.itemId = null;
            },
            toggle: async (c) => {
                await deps.setShopOpen(guildId, !c.state.shop.open);
                await reload(c.state);
            },
            add,
            details,
            limits,
            gives,
            role: async (c) => {
                const roleId = c.values[0];
                if (roleId) await save(c, { role_id: roleId });
            },
            duration,
            up: move("up"),
            down: move("down"),
            remove,
            salesChannel: async (c) => {
                await deps.setSalesChannel(guildId, c.values[0] ?? null);
                await reload(c.state);
            },
        },
    });
}
