import { formatSeeds, generatePurchaseCode } from "../constants/shop.constants";
import type { buyItem, getPurchaseByCode, markDelivered, refundPurchase, refundWouldRemoveRole } from "../repository/purchases.repository";
import type { getItem, getShop } from "../repository/shop.repository";
import type { PurchaseRow, ShopItemRow } from "../types";
import type { GuildLogEntry } from "./guild-log.service";

const CODE_ATTEMPTS = 5;

export type BuyBlocker = { kind: "short"; short: number } | { kind: "sold_out" } | { kind: "has_role" } | { kind: "limit"; max: number };

/** Why a member cannot buy an item right now, or null. Order: sold out, limit, role held, short. */
export function buyBlocker(input: {
    item: ShopItemRow;
    seeds: number;
    bought: number;
    holdsRole: boolean;
    activeGrantEnd: Date | null;
}): BuyBlocker | null {
    const { item, seeds, bought, holdsRole, activeGrantEnd } = input;
    if (item.stock === 0) return { kind: "sold_out" };
    if (item.max_per_member !== null && bought >= item.max_per_member) return { kind: "limit", max: item.max_per_member };
    // A timed role the shop itself gave stacks time; one held any other way is refused like a permanent role.
    if (holdsRole && (item.kind === "role" || (item.kind === "timed_role" && activeGrantEnd === null))) return { kind: "has_role" };
    if (seeds < item.price) return { kind: "short", short: item.price - seeds };
    return null;
}

export function blockerLabel(b: BuyBlocker): string {
    switch (b.kind) {
        case "short":
            return `${formatSeeds(b.short).replaceAll("`", "")} short`; // labels are plain text, no inline code
        case "sold_out":
            return "Sold out";
        case "has_role":
            return "You have this role";
        case "limit":
            return `Limit reached (${b.max})`;
    }
}

/** The warning line for a role the bot cannot give, or null when it can. */
export function roleProblem(
    role: { managed: boolean; id: string; position: number } | null,
    guildId: string,
    botTopPosition: number,
    botCanManageRoles: boolean,
): string | null {
    if (!role) return "⚠️ That role no longer exists.";
    if (role.managed || role.id === guildId || role.position >= botTopPosition)
        return `⚠️ The bot can't give <@&${role.id}> - move the bot's role above it.`;
    if (!botCanManageRoles) return `⚠️ The bot needs Manage Roles to give <@&${role.id}>.`;
    return null;
}

/** What the shop flows need from the database and Discord, injected so tests use neither. */
export interface ShopDeps {
    now(): Date;
    random(): number;
    economyOn(guildId: string): Promise<boolean>;
    getShop: typeof getShop;
    getItem: typeof getItem;
    buyItem: typeof buyItem;
    refundPurchase: typeof refundPurchase;
    markDelivered: typeof markDelivered;
    getPurchaseByCode: typeof getPurchaseByCode;
    refundWouldRemoveRole: typeof refundWouldRemoveRole;
    addRole(guildId: string, discordUserId: string, roleId: string): Promise<void>;
    removeRole(guildId: string, discordUserId: string, roleId: string): Promise<void>;
    postSale(purchase: PurchaseRow): Promise<void>;
    updateSalePost(purchase: PurchaseRow): Promise<void>;
    log(guildId: string, entry: GuildLogEntry): Promise<void>;
}

export type PurchaseOutcome =
    | { kind: "ok"; purchase: PurchaseRow; seedsLeft: number }
    | { kind: "role_failed"; purchase: PurchaseRow }
    | { kind: "closed" }
    | Exclude<Awaited<ReturnType<typeof buyItem>>, { kind: "ok" }>;

const isCodeClash = (err: unknown) => (err as { code?: string } | null)?.code === "23505";

/** Runs `fn`, sending a failure to the guild log as a warning instead of throwing. */
async function logFailure(deps: ShopDeps, guildId: string, title: string, body: string, run: () => Promise<void>): Promise<void> {
    try {
        await run();
    } catch (err) {
        await deps
            .log(guildId, { kind: "warning", title, body: `${body}\n${err instanceof Error ? err.message : String(err)}` })
            .catch(() => {});
    }
}

const refreshPost = (deps: ShopDeps, guildId: string, purchase: PurchaseRow) =>
    logFailure(deps, guildId, "⚠️ Couldn't update a shop sale", `Purchase \`${purchase.code}\`.`, () => deps.updateSalePost(purchase));

/** Buys an item and delivers what can be delivered at once: role kinds get the role, a failed grant is refunded. */
export async function purchaseItem(
    deps: ShopDeps,
    input: { guildId: string; itemId: number; userId: number; buyerDiscordId: string; expectedPrice: number },
): Promise<PurchaseOutcome> {
    const { guildId, itemId, userId, buyerDiscordId, expectedPrice } = input;
    if (!(await deps.economyOn(guildId))) return { kind: "closed" };
    const shop = await deps.getShop(guildId);
    if (!shop?.open) return { kind: "closed" };

    let result: Awaited<ReturnType<typeof buyItem>> | null = null;
    for (let attempt = 1; !result; attempt++) {
        try {
            result = await deps.buyItem({
                guildId,
                itemId,
                userId,
                buyerDiscordId,
                expectedPrice,
                code: generatePurchaseCode(deps.random),
                now: deps.now(),
            });
        } catch (err) {
            if (!isCodeClash(err) || attempt >= CODE_ATTEMPTS) throw err;
        }
    }
    if (result.kind !== "ok") return result;

    let { purchase } = result;
    let failed = false;
    if ((purchase.kind === "role" || purchase.kind === "timed_role") && purchase.role_id) {
        const roleId = purchase.role_id;
        try {
            await deps.addRole(guildId, buyerDiscordId, roleId);
        } catch {
            failed = true;
            let refunded = false;
            try {
                const refund = await deps.refundPurchase({
                    guildId,
                    code: purchase.code,
                    by: null,
                    reason: "role_failed",
                    now: deps.now(),
                });
                if (refund.kind === "ok" || refund.kind === "already_refunded") {
                    refunded = true;
                    purchase = refund.purchase;
                }
            } catch {
                // Falls through to the log below, which says the refund did not land.
            }
            const outcome = refunded ? "The Seeds went back." : `The refund failed - refund \`${purchase.code}\` by hand.`;
            await deps
                .log(guildId, {
                    kind: "warning",
                    title: "⚠️ Couldn't give a shop role",
                    body: `<@&${roleId}> for <@${buyerDiscordId}>, purchase \`${purchase.code}\`. ${outcome}`,
                })
                .catch(() => {});
        }
    }

    await logFailure(deps, guildId, "⚠️ Couldn't post a shop sale", `Purchase \`${purchase.code}\`.`, () => deps.postSale(purchase));
    return failed ? { kind: "role_failed", purchase } : { kind: "ok", purchase, seedsLeft: result.seedsLeft };
}

/** Refunds a purchase, takes the role back when the repository says so and refreshes the sale post. */
export async function refundFlow(deps: ShopDeps, guildId: string, code: string, by: string) {
    const res = await deps.refundPurchase({ guildId, code, by, reason: null, now: deps.now() });
    if (res.kind !== "ok") return res;
    const { purchase } = res;
    if (res.removeRole && purchase.role_id) {
        const roleId = purchase.role_id;
        await logFailure(
            deps,
            guildId,
            "⚠️ Couldn't remove a shop role",
            `<@&${roleId}> from <@${purchase.buyer_discord_id}>, purchase \`${purchase.code}\`. The refund went through.`,
            () => deps.removeRole(guildId, purchase.buyer_discord_id, roleId),
        );
    }
    await refreshPost(deps, guildId, purchase);
    return res;
}

/** Marks a pending purchase delivered and refreshes the sale post. */
export async function deliverFlow(deps: ShopDeps, guildId: string, code: string, by: string) {
    const res = await deps.markDelivered({ guildId, code, by, now: deps.now() });
    if (res.kind === "ok") {
        await refreshPost(deps, guildId, res.purchase);
    }
    return res;
}
