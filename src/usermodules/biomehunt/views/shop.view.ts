import { ActionRowBuilder, type ButtonBuilder, ButtonStyle, ContainerBuilder, MessageFlags, SeparatorSpacingSize } from "discord.js";
import { defineView, type HandlerContext, paginationHandlers, paginationRow, type RenderKit, type ViewDefinition } from "@/define";
import { NO_PINGS } from "@/utils/format";
import { formatPurchaseCode, formatSeeds, PURCHASES_PER_PAGE, SHOP_ITEMS_PER_PAGE } from "../constants/shop.constants";
import type { countMemberItemPurchases, getActiveGrantEnd, listMemberPurchases } from "../repository/purchases.repository";
import type { getItem, getShop, listLiveItems } from "../repository/shop.repository";
import { type BuyBlocker, blockerLabel, buyBlocker, type PurchaseOutcome, type purchaseItem } from "../services/shop.service";
import type { PurchaseRow, ShopItemRow, UserRow } from "../types";
import { durationText, nameLine, numbers } from "./shop-admin.screens";

/** What `/bh shop` needs from the database and Discord, injected so its tests use neither. */
export interface MemberShopDeps {
    now(): Date;
    economyOn(guildId: string): Promise<boolean>;
    getShop: typeof getShop;
    listLiveItems: typeof listLiveItems;
    getItem: typeof getItem;
    /** The member's current Seeds, or null when the profile is gone. */
    getSeeds(): Promise<number | null>;
    listMemberPurchases: typeof listMemberPurchases;
    countMemberItemPurchases: typeof countMemberItemPurchases;
    getActiveGrantEnd: typeof getActiveGrantEnd;
    /** Whether the member holds the role right now. */
    holdsRole(roleId: string): boolean;
    /** `purchaseItem` bound to the real `ShopDeps`. */
    purchaseItem(input: Parameters<typeof purchaseItem>[1]): Promise<PurchaseOutcome>;
}

export type MemberShopScreen = "list" | "item" | "confirm" | "bought" | "purchases";

export interface MemberShopState {
    screen: MemberShopScreen;
    /** Page of the list or of My purchases, whichever is showing. */
    page: number;
    guildId: string;
    user: UserRow;
    seeds: number;
    /** The economy is on and the shop is open. */
    visible: boolean;
    items: ShopItemRow[];
    item: ShopItemRow | null;
    blocker: BuyBlocker | null;
    /** End of the member's running grant for the item's role. */
    activeEnd: Date | null;
    /** The price the member is confirming. */
    price: number;
    priceChanged: boolean;
    bought: { purchase: PurchaseRow; seedsLeft: number } | null;
    purchases: PurchaseRow[];
    purchaseTotal: number;
}

type Ctx = HandlerContext<MemberShopState, void>;
type Parts = Array<ContainerBuilder | ActionRowBuilder<ButtonBuilder>>;

const ACCENT = 0x5865f2;
const CLOSED = "The shop is closed.";
const GONE = "This item is no longer in the shop.";
const unix = (d: Date) => Math.floor(d.getTime() / 1000);
const row = (...buttons: ButtonBuilder[]) => new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);
const isRoleKind = (kind: ShopItemRow["kind"]) => kind === "role" || kind === "timed_role";

const listPages = (s: Pick<MemberShopState, "items">) => Math.max(1, Math.ceil(s.items.length / SHOP_ITEMS_PER_PAGE));
const purchasePages = (s: Pick<MemberShopState, "purchaseTotal">) => Math.max(1, Math.ceil(s.purchaseTotal / PURCHASES_PER_PAGE));

/** The plain line for a buy that failed, by blocker. */
function blockerLine(b: BuyBlocker): string {
    switch (b.kind) {
        case "sold_out":
            return "It just sold out.";
        case "limit":
            return "You reached the limit for this item.";
        case "short":
            return `You're ${formatSeeds(b.short)} short.`;
        case "has_role":
            return "You already have this role.";
    }
}

/** The role, with its duration for a timed one; nothing for a manual item. */
function gives(item: ShopItemRow): string[] {
    if (item.kind === "manual" || !item.role_id) return [];
    const role = `<@&${item.role_id}>`;
    return [item.kind === "timed_role" && item.duration_s ? `${role} for ${durationText(item.duration_s)}` : role];
}

/** Stock and per-member limit, as in the admin list. */
const limits = (item: ShopItemRow) => numbers(item);

/** U3 / U3a / U3b: what the member gets and keeps. */
function confirmText(s: MemberShopState): string {
    const item = s.item as ShopItemRow;
    const keep = formatSeeds(s.seeds - s.price);
    const role = `<@&${item.role_id}>`;
    if (s.priceChanged) return `**The price changed to ${formatSeeds(s.price)}.**\nBuy ${item.name} anyway? You keep ${keep}.`;
    let body: string;
    if (item.kind === "manual") body = `You keep ${keep}.`;
    else if (item.kind === "role") body = `You get ${role} and keep ${keep}.`;
    else if (s.activeEnd) {
        const next = new Date(s.activeEnd.getTime() + (item.duration_s ?? 0) * 1000);
        body = `Your ${role} runs until <t:${unix(s.activeEnd)}:D> - this moves it to <t:${unix(next)}:D>. You keep ${keep}.`;
    } else body = `You get ${role} for ${durationText(item.duration_s ?? 0)} and keep ${keep}.`;
    return `**Buy ${item.name} for ${formatSeeds(s.price)}?**\n${body}`;
}

/** U4: the bought screen. */
function boughtText(b: NonNullable<MemberShopState["bought"]>): string {
    const p = b.purchase;
    const left = formatSeeds(b.seedsLeft);
    let line: string;
    if (p.kind === "manual" || !p.role_id) line = `An admin will deliver it. You have ${left} left.`;
    else if (p.kind === "timed_role" && p.role_ends_at)
        line = `You have <@&${p.role_id}> until <t:${unix(p.role_ends_at)}:D> and ${left} left.`;
    else line = `You have <@&${p.role_id}> and ${left} left.`;
    return `**✅ You bought ${p.item_name}**\nPurchase ID \`${formatPurchaseCode(p.code)}\`\n${line}`;
}

/** The second line of a purchase in My purchases. */
function purchaseStatus(p: PurchaseRow, now: Date): string {
    if (p.status === "pending") return `⏳ Pending · <t:${unix(p.created_at)}:R>`;
    if (p.status === "refunded") return `↩️ Refunded · <t:${unix(p.decided_at ?? p.created_at)}:R>`;
    if (isRoleKind(p.kind) && p.role_id) {
        if (p.kind === "timed_role" && p.role_ends_at) {
            const end = unix(p.role_ends_at);
            return p.role_ends_at > now
                ? `✅ Delivered · <@&${p.role_id}> runs out <t:${end}:R>`
                : `✅ Delivered · <@&${p.role_id}> ran out <t:${end}:D>`;
        }
        return `✅ Delivered · <@&${p.role_id}>`;
    }
    return `✅ Delivered · <t:${unix(p.decided_at ?? p.created_at)}:R>`;
}

function container(): { container: ContainerBuilder; divider: () => void } {
    const c = new ContainerBuilder().setAccentColor(ACCENT);
    return { container: c, divider: () => c.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small)) };
}

function tabsRow(s: MemberShopState, kit: RenderKit): ActionRowBuilder<ButtonBuilder> {
    const tabs = [
        { key: "list", label: "Shop" },
        { key: "purchases", label: "My purchases" },
    ] as const;
    return row(
        ...tabs.map((t) =>
            kit.button(`tab:${t.key}`, (b) =>
                b
                    .setLabel(t.label)
                    .setStyle(t.key === s.screen ? ButtonStyle.Primary : ButtonStyle.Secondary)
                    .setDisabled(t.key === s.screen),
            ),
        ),
    );
}

function listScreen(s: MemberShopState, kit: RenderKit): Parts {
    const { container: c, divider } = container();
    if (!s.visible) c.addTextDisplayComponents((td) => td.setContent(`## Shop\n${CLOSED}`));
    else {
        c.addTextDisplayComponents((td) => td.setContent(`## Shop\nYou have ${formatSeeds(s.seeds)}`));
        divider();
        if (s.items.length === 0) c.addTextDisplayComponents((td) => td.setContent("Nothing for sale yet."));
        s.items.slice(s.page * SHOP_ITEMS_PER_PAGE, (s.page + 1) * SHOP_ITEMS_PER_PAGE).forEach((item, slot, shown) => {
            const sub = [...gives(item), ...limits(item)].join(" · ");
            c.addSectionComponents((section) =>
                section
                    .addTextDisplayComponents((td) =>
                        td.setContent(`${nameLine(item)} · ${formatSeeds(item.price)}${sub ? `\n-# ${sub}` : ""}`),
                    )
                    .setButtonAccessory(kit.button(`view:${slot}`, (b) => b.setLabel("View"))),
            );
            if (slot < shown.length - 1) divider();
        });
    }
    const parts: Parts = [c];
    if (s.visible && listPages(s) > 1) parts.push(paginationRow(kit, s.page, listPages(s)));
    parts.push(tabsRow(s, kit));
    return parts;
}

function itemScreen(s: MemberShopState, kit: RenderKit): Parts {
    const item = s.item as ShopItemRow;
    const { container: c, divider } = container();
    const heading = `## ${item.emoji ? `${item.emoji} ` : ""}${item.name}${item.description ? `\n${item.description}` : ""}`;
    const imageUrl = item.image_url;
    if (imageUrl) {
        c.addSectionComponents((section) =>
            section.addTextDisplayComponents((td) => td.setContent(heading)).setThumbnailAccessory((t) => t.setURL(imageUrl)),
        );
    } else c.addTextDisplayComponents((td) => td.setContent(heading));
    divider();
    c.addTextDisplayComponents((td) => td.setContent([formatSeeds(item.price), ...gives(item), ...limits(item)].join(" · ")));
    const blocker = s.blocker;
    return [
        c,
        row(
            blocker
                ? kit.button("blocked", (b) =>
                      b
                          .setLabel(blockerLabel(blocker))
                          .setStyle(blocker.kind === "short" ? ButtonStyle.Success : ButtonStyle.Secondary)
                          .setDisabled(true),
                  )
                : kit.button("buy", (b) => b.setLabel("Buy").setStyle(ButtonStyle.Success)),
            kit.button("back", (b) => b.setLabel("Back")),
        ),
    ];
}

function confirmScreen(s: MemberShopState, kit: RenderKit): Parts {
    const { container: c } = container();
    c.addTextDisplayComponents((td) => td.setContent(confirmText(s)));
    return [
        c,
        row(
            kit.button("confirm", (b) => b.setLabel("Buy").setStyle(ButtonStyle.Success)),
            kit.button("cancel", (b) => b.setLabel("Cancel")),
        ),
    ];
}

function boughtScreen(s: MemberShopState, kit: RenderKit): Parts {
    const { container: c } = container();
    c.addTextDisplayComponents((td) => td.setContent(s.bought ? boughtText(s.bought) : ""));
    return [
        c,
        row(
            kit.button("toShop", (b) => b.setLabel("Back to shop")),
            kit.button("tab:purchases", (b) => b.setLabel("My purchases")),
        ),
    ];
}

function purchasesScreen(s: MemberShopState, kit: RenderKit, now: Date): Parts {
    const { container: c, divider } = container();
    c.addTextDisplayComponents((td) => td.setContent("**My purchases**"));
    divider();
    if (s.purchases.length === 0) c.addTextDisplayComponents((td) => td.setContent("No purchases yet."));
    else {
        c.addTextDisplayComponents((td) =>
            td.setContent(
                s.purchases
                    .map(
                        (p) =>
                            `\`${formatPurchaseCode(p.code)}\` · ${p.item_emoji ? `${p.item_emoji} ` : ""}**${p.item_name}** · ${formatSeeds(p.price)}\n-# ${purchaseStatus(p, now)}`,
                    )
                    .join("\n"),
            ),
        );
    }
    const parts: Parts = [c];
    if (purchasePages(s) > 1) parts.push(paginationRow(kit, s.page, purchasePages(s)));
    parts.push(tabsRow(s, kit));
    return parts;
}

/**
 * `/bh shop`: the shop list, an item card, the confirm and the bought screens, and My purchases.
 * The card, the confirm and the Buy click each re-read the item, the Seeds and the role, so a stale screen never charges.
 */
export function memberShopView(deps: MemberShopDeps): ViewDefinition<MemberShopState, void, { guildId: string; user: UserRow }> {
    /** Re-reads the economy flag, the shop, its live items and the Seeds. */
    async function loadShop(s: MemberShopState): Promise<void> {
        const [economyOn, shop, seeds] = await Promise.all([deps.economyOn(s.guildId), deps.getShop(s.guildId), deps.getSeeds()]);
        s.visible = economyOn && !!shop?.open;
        s.items = s.visible ? await deps.listLiveItems(s.guildId) : [];
        if (seeds !== null) s.seeds = seeds;
        s.page = Math.min(s.page, listPages(s) - 1);
    }

    /** Re-reads the current page of purchases; steps back a page when the list shrank. */
    async function loadPurchases(s: MemberShopState): Promise<void> {
        let res = await deps.listMemberPurchases(s.user.id, s.page * PURCHASES_PER_PAGE, PURCHASES_PER_PAGE);
        const last = Math.max(0, Math.ceil(res.total / PURCHASES_PER_PAGE) - 1);
        if (s.page > last) {
            s.page = last;
            res = await deps.listMemberPurchases(s.user.id, s.page * PURCHASES_PER_PAGE, PURCHASES_PER_PAGE);
        }
        Object.assign(s, { purchases: res.rows, purchaseTotal: res.total });
    }

    /** Re-reads an item and everything that decides whether the member can buy it. False when the item is gone. */
    async function loadItem(s: MemberShopState, itemId: number): Promise<boolean> {
        const item = await deps.getItem(s.guildId, itemId);
        if (!item || item.removed_at) return false;
        const roleId = isRoleKind(item.kind) ? item.role_id : null;
        const [bought, activeEnd, seeds] = await Promise.all([
            deps.countMemberItemPurchases(item.id, s.user.id),
            roleId ? deps.getActiveGrantEnd(s.user.id, roleId, deps.now()) : null,
            deps.getSeeds(),
        ]);
        if (seeds !== null) s.seeds = seeds;
        s.item = item;
        s.activeEnd = activeEnd;
        s.blocker = buyBlocker({
            item,
            seeds: s.seeds,
            bought,
            holdsRole: roleId ? deps.holdsRole(roleId) : false,
            activeGrantEnd: activeEnd,
        });
        return true;
    }

    const toList = async (s: MemberShopState): Promise<void> => {
        s.screen = "list";
        await loadShop(s);
    };

    /** The item went away: say so and show the list. */
    const gone = async (c: Ctx): Promise<void> => {
        await c.notify(GONE);
        await toList(c.state);
    };

    /** Back to the item's card with fresh state. */
    const toItem = async (c: Ctx): Promise<void> => {
        const id = c.state.item?.id;
        if (id === undefined || !(await loadItem(c.state, id))) return gone(c);
        c.state.screen = "item";
    };

    const confirmBuy = async (c: Ctx): Promise<void> => {
        const s = c.state;
        const id = s.item?.id;
        if (id === undefined) return;
        if (!(await deps.economyOn(s.guildId))) {
            await c.notify(CLOSED);
            return toList(s);
        }
        // purchaseItem can't see the member's roles, so the "has role" refusal is checked here, on fresh state.
        if (!(await loadItem(s, id))) return gone(c);
        if (s.blocker) {
            await c.notify(blockerLine(s.blocker));
            s.screen = "item";
            return;
        }
        const out = await deps.purchaseItem({
            guildId: s.guildId,
            itemId: id,
            userId: s.user.id,
            buyerDiscordId: s.user.discord_user_id,
            expectedPrice: s.price,
        });
        switch (out.kind) {
            case "ok":
                Object.assign(s, { bought: { purchase: out.purchase, seedsLeft: out.seedsLeft }, seeds: out.seedsLeft, screen: "bought" });
                return;
            case "price_changed":
                if (s.seeds < out.price) {
                    await c.notify(blockerLine({ kind: "short", short: out.price - s.seeds }));
                    return toItem(c);
                }
                Object.assign(s, { price: out.price, priceChanged: true });
                return;
            case "role_failed":
                await c.notify(`The bot couldn't give you <@&${out.purchase.role_id}>, so you weren't charged.`);
                return toItem(c);
            case "gone":
                return gone(c);
            case "closed":
                await c.notify(CLOSED);
                return toList(s);
            case "sold_out":
                await c.notify(blockerLine({ kind: "sold_out" }));
                return toItem(c);
            case "limit":
                await c.notify(blockerLine({ kind: "limit", max: out.max }));
                return toItem(c);
            case "short":
                await c.notify(blockerLine({ kind: "short", short: out.short }));
                return toItem(c);
        }
    };

    const paging = paginationHandlers<MemberShopState>({ pages: (s) => (s.screen === "purchases" ? purchasePages(s) : listPages(s)) });
    const paged = Object.fromEntries(
        Object.entries(paging).map(([key, handler]) => [
            key,
            async (c: Ctx) => {
                await handler(c);
                if (c.state.screen === "purchases") await loadPurchases(c.state);
            },
        ]),
    );

    return defineView<MemberShopState, void, { guildId: string; user: UserRow }>({
        name: "biomehunt.shop",
        initial: async ({ guildId, user }) => {
            const state: MemberShopState = {
                screen: "list",
                page: 0,
                guildId,
                user,
                seeds: user.seeds,
                visible: false,
                items: [],
                item: null,
                blocker: null,
                activeEnd: null,
                price: 0,
                priceChanged: false,
                bought: null,
                purchases: [],
                purchaseTotal: 0,
            };
            await loadShop(state);
            return state;
        },
        render: (s, kit) => {
            const screens: Record<MemberShopScreen, () => Parts> = {
                list: () => listScreen(s, kit),
                item: () => itemScreen(s, kit),
                confirm: () => confirmScreen(s, kit),
                bought: () => boughtScreen(s, kit),
                purchases: () => purchasesScreen(s, kit, deps.now()),
            };
            return { flags: MessageFlags.IsComponentsV2, components: screens[s.screen](), allowedMentions: NO_PINGS };
        },
        on: {
            ...paged,
            "tab:list": async (c) => {
                c.state.page = 0;
                await toList(c.state);
            },
            "tab:purchases": async (c) => {
                Object.assign(c.state, { screen: "purchases", page: 0 });
                await loadPurchases(c.state);
            },
            toShop: async (c) => {
                c.state.page = 0;
                await toList(c.state);
            },
            ...Object.fromEntries(
                Array.from({ length: SHOP_ITEMS_PER_PAGE }, (_, slot) => [
                    `view:${slot}`,
                    async (c: Ctx) => {
                        const item = c.state.items[c.state.page * SHOP_ITEMS_PER_PAGE + slot];
                        if (!item) return;
                        c.state.item = item;
                        await toItem(c);
                    },
                ]),
            ),
            back: async (c) => {
                await toList(c.state);
            },
            buy: async (c) => {
                await toItem(c);
                const { item, blocker, screen } = c.state;
                if (screen !== "item" || blocker || !item) return;
                Object.assign(c.state, { screen: "confirm", price: item.price, priceChanged: false });
            },
            cancel: toItem,
            confirm: confirmBuy,
        },
    });
}
