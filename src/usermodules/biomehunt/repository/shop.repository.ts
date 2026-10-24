import { query, transaction } from "@/database/connection";
import type { ShopItemFields, ShopItemRow, ShopRow } from "../types";

const SHOP_COLUMNS = "guild_id, open, sales_channel_id";
const ITEM_COLUMNS =
    "id, guild_id, name, description, emoji, image_url, price, kind, role_id, duration_s, stock, max_per_member, sort_order, removed_at";
const EDITABLE_FIELDS: Array<keyof ShopItemFields> = [
    "name",
    "description",
    "emoji",
    "image_url",
    "price",
    "kind",
    "role_id",
    "duration_s",
    "stock",
    "max_per_member",
];

export async function getShop(guildId: string): Promise<ShopRow | null> {
    const res = await query<ShopRow>(`SELECT ${SHOP_COLUMNS} FROM bh_shops WHERE guild_id = $1`, [guildId]);
    return res.rows[0] ?? null;
}

/** Returns the guild's shop, creating a closed one on first use. */
export async function ensureShop(guildId: string): Promise<ShopRow> {
    await query("INSERT INTO bh_shops (guild_id) VALUES ($1) ON CONFLICT (guild_id) DO NOTHING", [guildId]);
    const shop = await getShop(guildId);
    if (!shop) throw new Error(`Shop row missing for guild ${guildId}`);
    return shop;
}

export async function setShopOpen(guildId: string, open: boolean): Promise<void> {
    await query("UPDATE bh_shops SET open = $2, updated_at = NOW() WHERE guild_id = $1", [guildId, open]);
}

export async function setSalesChannel(guildId: string, channelId: string | null): Promise<void> {
    await query("UPDATE bh_shops SET sales_channel_id = $2, updated_at = NOW() WHERE guild_id = $1", [guildId, channelId]);
}

export async function listLiveItems(guildId: string): Promise<ShopItemRow[]> {
    const res = await query<ShopItemRow>(
        `SELECT ${ITEM_COLUMNS} FROM bh_shop_items WHERE guild_id = $1 AND removed_at IS NULL ORDER BY sort_order, id`,
        [guildId],
    );
    return res.rows;
}

/** Fetches an item, removed ones included - purchases keep pointing at them. */
export async function getItem(guildId: string, itemId: number): Promise<ShopItemRow | null> {
    const res = await query<ShopItemRow>(`SELECT ${ITEM_COLUMNS} FROM bh_shop_items WHERE guild_id = $1 AND id = $2`, [guildId, itemId]);
    return res.rows[0] ?? null;
}

/** Adds an item at the end of the live list. */
export async function insertItem(guildId: string, fields: ShopItemFields): Promise<ShopItemRow> {
    const res = await query<ShopItemRow>(
        `INSERT INTO bh_shop_items (guild_id, name, description, emoji, image_url, price, kind, role_id, duration_s, stock, max_per_member, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                 (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM bh_shop_items WHERE guild_id = $1 AND removed_at IS NULL))
         RETURNING ${ITEM_COLUMNS}`,
        [
            guildId,
            fields.name,
            fields.description,
            fields.emoji,
            fields.image_url,
            fields.price,
            fields.kind,
            fields.role_id,
            fields.duration_s,
            fields.stock,
            fields.max_per_member,
        ],
    );
    return res.rows[0];
}

/** Updates only the fields in `patch`; null when the item doesn't exist. */
export async function updateItem(guildId: string, itemId: number, patch: Partial<ShopItemFields>): Promise<ShopItemRow | null> {
    const keys = EDITABLE_FIELDS.filter((key) => key in patch);
    if (keys.length === 0) return getItem(guildId, itemId);
    const sets = keys.map((key, i) => `${key} = $${i + 3}`);
    const res = await query<ShopItemRow>(
        `UPDATE bh_shop_items SET ${sets.join(", ")}, updated_at = NOW() WHERE guild_id = $1 AND id = $2 RETURNING ${ITEM_COLUMNS}`,
        [guildId, itemId, ...keys.map((key) => patch[key])],
    );
    return res.rows[0] ?? null;
}

/** Soft delete: purchases still reference the row. */
export async function removeItem(guildId: string, itemId: number): Promise<void> {
    await query("UPDATE bh_shop_items SET removed_at = NOW(), updated_at = NOW() WHERE guild_id = $1 AND id = $2 AND removed_at IS NULL", [
        guildId,
        itemId,
    ]);
}

/** Swaps the item with its live neighbour; false when it is already at that end (or not live). */
export async function moveItem(guildId: string, itemId: number, direction: "up" | "down"): Promise<boolean> {
    return transaction(async (client) => {
        const res = await client.query<{ id: number; sort_order: number }>(
            "SELECT id, sort_order FROM bh_shop_items WHERE guild_id = $1 AND removed_at IS NULL ORDER BY sort_order, id FOR UPDATE",
            [guildId],
        );
        const items = res.rows;
        const index = items.findIndex((item) => item.id === itemId);
        const neighbour = items[direction === "up" ? index - 1 : index + 1];
        if (index === -1 || !neighbour) return false;
        const current = items[index];
        // Sort orders are unique among live items (insert uses max + 1), so a plain swap is enough.
        await client.query("UPDATE bh_shop_items SET sort_order = $3, updated_at = NOW() WHERE guild_id = $1 AND id = $2", [
            guildId,
            current.id,
            neighbour.sort_order,
        ]);
        await client.query("UPDATE bh_shop_items SET sort_order = $3, updated_at = NOW() WHERE guild_id = $1 AND id = $2", [
            guildId,
            neighbour.id,
            current.sort_order,
        ]);
        return true;
    });
}
