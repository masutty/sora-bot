import { query } from "@/database/connection";
import type { UserFlowerRow } from "../types";

/** Counts one more time the member got this Flower. `isNew` is true when it is their first time. */
export async function recordFlower(userId: number, flower: string): Promise<{ isNew: boolean }> {
    const result = await query<{ times: number }>(
        `INSERT INTO bh_user_flowers (user_id, flower) VALUES ($1, $2)
         ON CONFLICT (user_id, flower) DO UPDATE SET times = bh_user_flowers.times + 1, last_at = NOW()
         RETURNING times`,
        [userId, flower],
    );
    return { isNew: result.rows[0]?.times === 1 };
}

/** Every Flower the member has got. */
export async function getHerbarium(userId: number): Promise<UserFlowerRow[]> {
    const result = await query<UserFlowerRow>(`SELECT * FROM bh_user_flowers WHERE user_id = $1`, [userId]);
    return result.rows;
}
