import { query, transaction } from "@/database/connection";
import type { PurchaseRow, ShopItemRow } from "../types";
import { adjustUserBalance } from "./rewards.repository";

const PURCHASE_COLUMNS =
    "id, code, guild_id, item_id, user_id, buyer_discord_id, item_name, item_emoji, price, kind, role_id, duration_s, role_ends_at, status, refund_reason, decided_by, decided_at, post_channel_id, post_message_id, created_at";

type Run = (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;

export type BuyResult =
    | { kind: "ok"; purchase: PurchaseRow; seedsLeft: number }
    | { kind: "gone" }
    | { kind: "price_changed"; price: number }
    | { kind: "sold_out" }
    | { kind: "limit"; max: number }
    | { kind: "short"; short: number };

export type RefundResult =
    | { kind: "ok"; purchase: PurchaseRow; removeRole: boolean; stockRestored: boolean }
    | { kind: "not_found" }
    | { kind: "already_refunded"; purchase: PurchaseRow };

export interface BuyInput {
    guildId: string;
    itemId: number;
    userId: number;
    buyerDiscordId: string;
    expectedPrice: number;
    code: string;
    now: Date;
}

/**
 * Buys one item in a single transaction: the item row lock serialises buyers, the conditional Seeds update can never go negative,
 * and stock, grant and purchase move together. A `code` clash throws the pg error (23505) for the caller to retry with a new code.
 */
export async function buyItem(input: BuyInput): Promise<BuyResult> {
    const { guildId, itemId, userId, buyerDiscordId, expectedPrice, code, now } = input;
    return transaction(async (client) => {
        const found = await client.query<ShopItemRow>(
            "SELECT * FROM bh_shop_items WHERE id = $1 AND guild_id = $2 AND removed_at IS NULL FOR UPDATE",
            [itemId, guildId],
        );
        const item = found.rows[0];
        if (!item) return { kind: "gone" };
        if (item.price !== expectedPrice) return { kind: "price_changed", price: item.price };
        if (item.stock === 0) return { kind: "sold_out" };
        if (item.max_per_member !== null) {
            const owned = await client.query<{ count: string }>(
                "SELECT COUNT(*) AS count FROM bh_shop_purchases WHERE item_id = $1 AND user_id = $2 AND status <> 'refunded'",
                [itemId, userId],
            );
            if (Number(owned.rows[0].count) >= item.max_per_member) return { kind: "limit", max: item.max_per_member };
        }

        const spent = await client.query<{ seeds: number }>(
            "UPDATE bh_users SET seeds = seeds - $2 WHERE id = $1 AND seeds >= $2 RETURNING seeds",
            [userId, item.price],
        );
        if (spent.rows.length === 0) {
            const bal = await client.query<{ seeds: number }>("SELECT seeds FROM bh_users WHERE id = $1", [userId]);
            return { kind: "short", short: Math.max(1, item.price - (bal.rows[0]?.seeds ?? 0)) };
        }

        if (item.stock !== null)
            await client.query("UPDATE bh_shop_items SET stock = stock - 1, updated_at = NOW() WHERE id = $1", [itemId]);

        let roleEndsAt: Date | null = null;
        if (item.kind === "timed_role") {
            const grant = await client.query<{ ends_at: Date }>(
                `INSERT INTO bh_shop_role_grants (user_id, guild_id, role_id, ends_at)
                 VALUES ($1, $2, $3, $4::timestamptz + $5::int * INTERVAL '1 second')
                 ON CONFLICT (user_id, role_id) DO UPDATE
                 SET ends_at = GREATEST($4::timestamptz, bh_shop_role_grants.ends_at) + $5::int * INTERVAL '1 second'
                 RETURNING ends_at`,
                [userId, guildId, item.role_id, now, item.duration_s],
            );
            roleEndsAt = grant.rows[0].ends_at;
            await client.query(
                "UPDATE bh_shop_purchases SET role_ends_at = $4 WHERE guild_id = $1 AND user_id = $2 AND role_id = $3 AND kind = 'timed_role' AND status <> 'refunded'",
                [guildId, userId, item.role_id, roleEndsAt],
            );
        }

        const purchase = await client.query<PurchaseRow>(
            `INSERT INTO bh_shop_purchases (code, guild_id, item_id, user_id, buyer_discord_id, item_name, item_emoji, price, kind, role_id, duration_s, role_ends_at, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
             RETURNING ${PURCHASE_COLUMNS}`,
            [
                code,
                guildId,
                itemId,
                userId,
                buyerDiscordId,
                item.name,
                item.emoji,
                item.price,
                item.kind,
                item.role_id,
                item.duration_s,
                roleEndsAt,
                item.kind === "manual" ? "pending" : "delivered",
            ],
        );
        return { kind: "ok", purchase: purchase.rows[0], seedsLeft: spent.rows[0].seeds };
    });
}

interface RoleRemoval {
    removeRole: boolean;
    /** Timed only: the grant's new end, or null when the grant goes away. */
    newEnd: Date | null;
    deleteGrant: boolean;
}

/** What refunding `p` does to the role. Read-only; shared by the refund and its confirm screen. */
async function planRoleRemoval(run: Run, p: PurchaseRow, now: Date, lock: boolean): Promise<RoleRemoval> {
    if (p.kind === "timed_role" && p.role_id && p.duration_s !== null) {
        const grant = await run(`SELECT ends_at FROM bh_shop_role_grants WHERE user_id = $1 AND role_id = $2${lock ? " FOR UPDATE" : ""}`, [
            p.user_id,
            p.role_id,
        ]);
        // No grant row: the worker already took the role back, nothing is left to remove.
        if (grant.rows.length === 0) return { removeRole: false, newEnd: null, deleteGrant: false };
        const newEnd = new Date(new Date(grant.rows[0].ends_at as Date).getTime() - p.duration_s * 1000);
        if (newEnd.getTime() <= now.getTime()) return { removeRole: true, newEnd: null, deleteGrant: true };
        return { removeRole: false, newEnd, deleteGrant: false };
    }
    if (p.kind === "role" && p.role_id) {
        const res = await run(
            `SELECT (EXISTS (SELECT 1 FROM bh_shop_purchases WHERE user_id = $1 AND role_id = $2 AND id <> $3 AND kind IN ('role', 'timed_role') AND status <> 'refunded')
                  OR EXISTS (SELECT 1 FROM bh_shop_role_grants WHERE user_id = $1 AND role_id = $2)) AS held`,
            [p.user_id, p.role_id, p.id],
        );
        return { removeRole: !res.rows[0]?.held, newEnd: null, deleteGrant: false };
    }
    return { removeRole: false, newEnd: null, deleteGrant: false };
}

/** Same rule `refundPurchase` applies, without writing - for the refund confirm. */
export async function refundWouldRemoveRole(p: PurchaseRow, now: Date): Promise<boolean> {
    return (await planRoleRemoval(query as Run, p, now, false)).removeRole;
}

export interface RefundInput {
    guildId: string;
    code: string;
    by: string | null;
    reason: "role_failed" | null;
    now: Date;
}

/** Gives the Seeds back, restores stock of a live item, rolls the role grant back and marks the purchase refunded - once. */
export async function refundPurchase(input: RefundInput): Promise<RefundResult> {
    const { guildId, code, by, reason, now } = input;
    return transaction(async (client) => {
        const run: Run = (sql, params) => client.query(sql, params);
        // Lock order matches buyItem (item, user, grant, purchases): peek at the item id, lock the item first, then the purchase row.
        const peek = await client.query<{ item_id: number }>("SELECT item_id FROM bh_shop_purchases WHERE guild_id = $1 AND code = $2", [
            guildId,
            code,
        ]);
        if (!peek.rows[0]) return { kind: "not_found" };
        await client.query("SELECT id FROM bh_shop_items WHERE id = $1 FOR UPDATE", [peek.rows[0].item_id]);
        const found = await client.query<PurchaseRow>(
            `SELECT ${PURCHASE_COLUMNS} FROM bh_shop_purchases WHERE guild_id = $1 AND code = $2 FOR UPDATE`,
            [guildId, code],
        );
        const purchase = found.rows[0];
        if (!purchase) return { kind: "not_found" };
        if (purchase.status === "refunded") return { kind: "already_refunded", purchase };

        await adjustUserBalance(client, purchase.user_id, purchase.price, 0);
        const restored = await client.query(
            "UPDATE bh_shop_items SET stock = stock + 1, updated_at = NOW() WHERE id = $1 AND removed_at IS NULL AND stock IS NOT NULL RETURNING id",
            [purchase.item_id],
        );

        const plan = await planRoleRemoval(run, purchase, now, true);
        if (plan.deleteGrant) {
            await client.query("DELETE FROM bh_shop_role_grants WHERE user_id = $1 AND role_id = $2", [purchase.user_id, purchase.role_id]);
        } else if (plan.newEnd) {
            await client.query("UPDATE bh_shop_role_grants SET ends_at = $3 WHERE user_id = $1 AND role_id = $2", [
                purchase.user_id,
                purchase.role_id,
                plan.newEnd.toISOString(),
            ]);
            await client.query(
                "UPDATE bh_shop_purchases SET role_ends_at = $5 WHERE guild_id = $1 AND user_id = $2 AND role_id = $3 AND id <> $4 AND kind = 'timed_role' AND status <> 'refunded'",
                [guildId, purchase.user_id, purchase.role_id, purchase.id, plan.newEnd.toISOString()],
            );
        }

        const marked = await client.query<PurchaseRow>(
            `UPDATE bh_shop_purchases SET status = 'refunded', refund_reason = $2, decided_by = $3, decided_at = $4 WHERE id = $1 RETURNING ${PURCHASE_COLUMNS}`,
            [purchase.id, reason, by, now],
        );
        return {
            kind: "ok",
            purchase: marked.rows[0] ?? { ...purchase, status: "refunded" },
            removeRole: plan.removeRole,
            stockRestored: restored.rows.length > 0,
        };
    });
}

/** Marks a pending purchase delivered; the status check makes a double click a no-op. */
export async function markDelivered(input: {
    guildId: string;
    code: string;
    by: string;
    now: Date;
}): Promise<{ kind: "ok"; purchase: PurchaseRow } | { kind: "not_found" } | { kind: "not_pending"; purchase: PurchaseRow }> {
    const { guildId, code, by, now } = input;
    const res = await query<PurchaseRow>(
        `UPDATE bh_shop_purchases SET status = 'delivered', decided_by = $3, decided_at = $4
         WHERE guild_id = $1 AND code = $2 AND status = 'pending' RETURNING ${PURCHASE_COLUMNS}`,
        [guildId, code, by, now],
    );
    if (res.rows[0]) return { kind: "ok", purchase: res.rows[0] };
    const existing = await getPurchaseByCode(guildId, code);
    return existing ? { kind: "not_pending", purchase: existing } : { kind: "not_found" };
}

export async function getPurchaseByCode(guildId: string, code: string): Promise<PurchaseRow | null> {
    const res = await query<PurchaseRow>(`SELECT ${PURCHASE_COLUMNS} FROM bh_shop_purchases WHERE guild_id = $1 AND code = $2`, [
        guildId,
        code,
    ]);
    return res.rows[0] ?? null;
}

/** One page of the server's purchases, newest first, plus the total for the filter. */
export async function listPurchases(
    guildId: string,
    filter: "pending" | "all",
    offset: number,
    limit: number,
): Promise<{ rows: PurchaseRow[]; total: number }> {
    const where = filter === "pending" ? "guild_id = $1 AND status = 'pending'" : "guild_id = $1";
    const [count, page] = await Promise.all([
        query<{ count: string }>(`SELECT COUNT(*) AS count FROM bh_shop_purchases WHERE ${where}`, [guildId]),
        query<PurchaseRow>(
            `SELECT ${PURCHASE_COLUMNS} FROM bh_shop_purchases WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
            [guildId, limit, offset],
        ),
    ]);
    return { rows: page.rows, total: Number(count.rows[0].count) };
}

export async function countPending(guildId: string): Promise<number> {
    const res = await query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM bh_shop_purchases WHERE guild_id = $1 AND status = 'pending'",
        [guildId],
    );
    return Number(res.rows[0].count);
}

/** One page of a member's purchases, newest first. */
export async function listMemberPurchases(userId: number, offset: number, limit: number): Promise<{ rows: PurchaseRow[]; total: number }> {
    const [count, page] = await Promise.all([
        query<{ count: string }>("SELECT COUNT(*) AS count FROM bh_shop_purchases WHERE user_id = $1", [userId]),
        query<PurchaseRow>(
            `SELECT ${PURCHASE_COLUMNS} FROM bh_shop_purchases WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
            [userId, limit, offset],
        ),
    ]);
    return { rows: page.rows, total: Number(count.rows[0].count) };
}

/** Non-refunded purchases of an item by a member - what `max_per_member` counts. */
export async function countMemberItemPurchases(itemId: number, userId: number): Promise<number> {
    const res = await query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM bh_shop_purchases WHERE item_id = $1 AND user_id = $2 AND status <> 'refunded'",
        [itemId, userId],
    );
    return Number(res.rows[0].count);
}

export async function setPurchasePost(purchaseId: number, channelId: string, messageId: string): Promise<void> {
    await query("UPDATE bh_shop_purchases SET post_channel_id = $2, post_message_id = $3 WHERE id = $1", [
        purchaseId,
        channelId,
        messageId,
    ]);
}

/** End of the member's shop grant for a role, or null when none is running. */
export async function getActiveGrantEnd(userId: number, roleId: string, now: Date): Promise<Date | null> {
    const res = await query<{ ends_at: Date }>(
        "SELECT ends_at FROM bh_shop_role_grants WHERE user_id = $1 AND role_id = $2 AND ends_at > $3",
        [userId, roleId, now],
    );
    return res.rows[0]?.ends_at ?? null;
}

/** Grants whose end has passed - the expiry worker removes these roles. */
export async function getDueGrants(
    now: Date,
    limit: number,
): Promise<Array<{ userId: number; guildId: string; discordUserId: string; roleId: string }>> {
    const res = await query<{ user_id: number; guild_id: string; discord_user_id: string; role_id: string }>(
        `SELECT g.user_id, g.guild_id, u.discord_user_id, g.role_id
         FROM bh_shop_role_grants g JOIN bh_users u ON u.id = g.user_id
         WHERE g.ends_at <= $1 ORDER BY g.ends_at LIMIT $2`,
        [now, limit],
    );
    return res.rows.map((r) => ({ userId: r.user_id, guildId: r.guild_id, discordUserId: r.discord_user_id, roleId: r.role_id }));
}

/** Deletes a grant only if it is still over (a renewal bought since the worker read it survives); true when a row went. */
export async function deleteGrant(userId: number, roleId: string, now: Date): Promise<boolean> {
    const res = await query("DELETE FROM bh_shop_role_grants WHERE user_id = $1 AND role_id = $2 AND ends_at <= $3 RETURNING user_id", [
        userId,
        roleId,
        now,
    ]);
    return res.rows.length > 0;
}

/** Running grants of one member in a server - the rejoin re-grant reads these. */
export async function getMemberActiveGrants(
    guildId: string,
    discordUserId: string,
    now: Date,
): Promise<Array<{ roleId: string; endsAt: Date }>> {
    const res = await query<{ role_id: string; ends_at: Date }>(
        `SELECT g.role_id, g.ends_at FROM bh_shop_role_grants g JOIN bh_users u ON u.id = g.user_id
         WHERE g.guild_id = $1 AND u.discord_user_id = $2 AND g.ends_at > $3`,
        [guildId, discordUserId, now],
    );
    return res.rows.map((r) => ({ roleId: r.role_id, endsAt: r.ends_at }));
}
