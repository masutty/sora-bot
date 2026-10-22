import { query } from "@/database/connection";
import type { BadgeRow, RobloxBadge } from "../types";

export async function upsertBadge(b: RobloxBadge, iconUrl: string | null, now: Date): Promise<void> {
    await query(
        `INSERT INTO bt_badges (badge_id, name, description, icon_url, awarded_count, last_checked_at, meta_refreshed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6)
         ON CONFLICT (badge_id) DO UPDATE
         SET name = $2, description = $3, icon_url = $4, deleted = FALSE, not_found_streak = 0`,
        [b.id, b.name, b.description, iconUrl, b.awardedCount, now],
    );
}

export async function getBadges(ids: string[]): Promise<BadgeRow[]> {
    const result = await query<BadgeRow>(`SELECT * FROM bt_badges WHERE badge_id = ANY($1)`, [ids]);
    return result.rows;
}

export async function getBadge(id: string): Promise<BadgeRow | null> {
    const result = await query<BadgeRow>(`SELECT * FROM bt_badges WHERE badge_id = $1`, [id]);
    return result.rows[0] ?? null;
}

export async function recordCheck(id: string, awardedCount: number, now: Date): Promise<void> {
    await query(`UPDATE bt_badges SET awarded_count = $2, last_checked_at = $3, not_found_streak = 0 WHERE badge_id = $1`, [
        id,
        awardedCount,
        now,
    ]);
}

export async function updateBadgeMeta(id: string, name: string, description: string, iconUrl: string | null, now: Date): Promise<void> {
    await query(`UPDATE bt_badges SET name = $2, description = $3, icon_url = $4, meta_refreshed_at = $5 WHERE badge_id = $1`, [
        id,
        name,
        description,
        iconUrl,
        now,
    ]);
}

/** Forgets the Baseline of every Badge not in `liveIds`, so the next check re-baselines silently. */
export async function clearBaselines(liveIds: string[]): Promise<void> {
    await query(`UPDATE bt_badges SET awarded_count = NULL WHERE NOT (badge_id = ANY($1))`, [liveIds]);
}

export async function incrementNotFound(id: string): Promise<number> {
    const result = await query<{ not_found_streak: number }>(
        `UPDATE bt_badges SET not_found_streak = not_found_streak + 1 WHERE badge_id = $1 RETURNING not_found_streak`,
        [id],
    );
    return result.rows[0]?.not_found_streak ?? 0;
}

export async function markDeleted(id: string): Promise<void> {
    await query(`UPDATE bt_badges SET deleted = TRUE WHERE badge_id = $1`, [id]);
}

export async function countBadges(): Promise<number> {
    const result = await query<{ count: string }>(`SELECT COUNT(*) AS count FROM bt_badges`);
    return Number(result.rows[0]?.count ?? 0);
}

export async function deleteOrphanBadges(): Promise<void> {
    await query(`DELETE FROM bt_badges b WHERE NOT EXISTS (SELECT 1 FROM bt_subscriptions s WHERE s.badge_id = b.badge_id)`);
}
