import { query } from "../../database/connection";
import type {
    RollingProfile,
    RollingItem,
    RollingAura,
    UserItem,
    UserAura,
} from "./types";

/* ───────────────────────────────────────────── */
/* Profiles                                     */
/* ───────────────────────────────────────────── */

export async function ensureProfile(
    userId: string,
): Promise<void> {
    await query(
        `
        INSERT INTO rolling_profiles (user_id)
        VALUES ($1)
        ON CONFLICT (user_id) DO NOTHING
        `,
        [userId],
    );
}


export async function getProfile(
    userId: string,
): Promise<RollingProfile | null> {
    const result = await query<RollingProfile>(
        `
        SELECT *
        FROM rolling_profiles
        WHERE user_id = $1
        `,
        [userId],
    );

    return result.rows[0] ?? null;
}


export async function addBalance(
    userId: string,
    amount: number,
): Promise<void> {
    await query(
        `
        UPDATE rolling_profiles
        SET balance = balance + $2
        WHERE user_id = $1
        `,
        [userId, amount],
    );
}


export async function setBalance(
    userId: string,
    amount: number,
): Promise<void> {
    await query(
        `
        UPDATE rolling_profiles
        SET balance = $2
        WHERE user_id = $1
        `,
        [userId, amount],
    );
}


/* ───────────────────────────────────────────── */
/* Item definitions                             */
/* ───────────────────────────────────────────── */

export async function createItem(
    name: string,
    description: string | null,
    rollChance: number,
): Promise<RollingItem> {
    const result = await query<RollingItem>(
        `
        INSERT INTO rolling_items (
            name,
            description,
            roll_chance
        )
        VALUES ($1, $2, $3)
        RETURNING *
        `,
        [name, description, rollChance],
    );

    return result.rows[0];
}


export async function getItem(
    itemId: number,
): Promise<RollingItem | null> {
    const result = await query<RollingItem>(
        `
        SELECT *
        FROM rolling_items
        WHERE id = $1
        `,
        [itemId],
    );

    return result.rows[0] ?? null;
}


export async function getAllEnabledItems(): Promise<RollingItem[]> {
    const result = await query<RollingItem>(
        `
        SELECT *
        FROM rolling_items
        WHERE enabled = TRUE
        ORDER BY roll_chance DESC
        `,
    );

    return result.rows;
}


export async function setItemEnabled(
    itemId: number,
    enabled: boolean,
): Promise<void> {
    await query(
        `
        UPDATE rolling_items
        SET enabled = $2
        WHERE id = $1
        `,
        [itemId, enabled],
    );
}


export async function deleteItem(
    itemId: number,
): Promise<void> {
    await query(
        `
        DELETE FROM rolling_items
        WHERE id = $1
        `,
        [itemId],
    );
}


/* ───────────────────────────────────────────── */
/* Aura definitions                             */
/* ───────────────────────────────────────────── */

export async function createAura(
    name: string,
    description: string | null,
    rollChance: number,
): Promise<RollingAura> {
    const result = await query<RollingAura>(
        `
        INSERT INTO rolling_auras (
            name,
            description,
            roll_chance
        )
        VALUES ($1, $2, $3)
        RETURNING *
        `,
        [name, description, rollChance],
    );

    return result.rows[0];
}


export async function getAura(
    auraId: number,
): Promise<RollingAura | null> {
    const result = await query<RollingAura>(
        `
        SELECT *
        FROM rolling_auras
        WHERE id = $1
        `,
        [auraId],
    );

    return result.rows[0] ?? null;
}


export async function getAllEnabledAuras(): Promise<RollingAura[]> {
    const result = await query<RollingAura>(
        `
        SELECT *
        FROM rolling_auras
        WHERE enabled = TRUE
        ORDER BY roll_chance DESC
        `,
    );

    return result.rows;
}


export async function setAuraEnabled(
    auraId: number,
    enabled: boolean,
): Promise<void> {
    await query(
        `
        UPDATE rolling_auras
        SET enabled = $2
        WHERE id = $1
        `,
        [auraId, enabled],
    );
}


export async function deleteAura(
    auraId: number,
): Promise<void> {
    await query(
        `
        DELETE FROM rolling_auras
        WHERE id = $1
        `,
        [auraId],
    );
}


/* ───────────────────────────────────────────── */
/* User Items                                   */
/* ───────────────────────────────────────────── */

export async function addItemToUser(
    userId: string,
    itemId: number,
    quantity: number = 1,
): Promise<void> {
    await query(
        `
        INSERT INTO rolling_user_items (
            user_id,
            item_id,
            quantity
        )
        VALUES ($1, $2, $3)

        ON CONFLICT (user_id, item_id)
        DO UPDATE SET
            quantity = rolling_user_items.quantity + $3
        `,
        [userId, itemId, quantity],
    );
}


export async function removeItemFromUser(
    userId: string,
    itemId: number,
    quantity: number = 1,
): Promise<void> {
    await query(
        `
        UPDATE rolling_user_items
        SET quantity = quantity - $3
        WHERE user_id = $1
          AND item_id = $2
        `,
        [userId, itemId, quantity],
    );

    await query(
        `
        DELETE FROM rolling_user_items
        WHERE user_id = $1
          AND item_id = $2
          AND quantity <= 0
        `,
        [userId, itemId],
    );
}


export async function getUserItems(
    userId: string,
): Promise<(UserItem & { name: string })[]> {
    const result = await query<UserItem & { name: string }>(
        `
        SELECT
            ui.*,
            i.name
        FROM rolling_user_items ui
        INNER JOIN rolling_items i
            ON ui.item_id = i.id
        WHERE ui.user_id = $1
        ORDER BY i.name ASC
        `,
        [userId],
    );

    return result.rows;
}


/* ───────────────────────────────────────────── */
/* User Auras                                   */
/* ───────────────────────────────────────────── */

export async function addAuraToUser(
    userId: string,
    auraId: number,
): Promise<UserAura> {
    const result = await query<UserAura>(
        `
        INSERT INTO rolling_user_auras (
            user_id,
            aura_id
        )
        VALUES ($1, $2)
        RETURNING *
        `,
        [userId, auraId],
    );

    return result.rows[0];
}


export async function getUserAuras(
    userId: string,
): Promise<(UserAura & { name: string })[]> {
    const result = await query<UserAura & { name: string }>(
        `
        SELECT
            ua.*,
            a.name
        FROM rolling_user_auras ua
        INNER JOIN rolling_auras a
            ON ua.aura_id = a.id
        WHERE ua.user_id = $1
        ORDER BY ua.obtained_at DESC
        `,
        [userId],
    );

    return result.rows;
}


export async function countUserAuras(
    userId: string,
): Promise<number> {
    const result = await query<{ count: string }>(
        `
        SELECT COUNT(*) AS count
        FROM rolling_user_auras
        WHERE user_id = $1
        `,
        [userId],
    );

    return Number(result.rows[0]?.count ?? 0);
}


/* ───────────────────────────────────────────── */
/* Utility                                      */
/* ───────────────────────────────────────────── */

export async function userExists(
    userId: string,
): Promise<boolean> {
    const result = await query(
        `
        SELECT 1
        FROM rolling_profiles
        WHERE user_id = $1
        LIMIT 1
        `,
        [userId],
    );

    return (result.rowCount ?? 0) > 0;
}
