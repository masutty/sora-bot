import { query } from "@/database/connection";
import type { RoleJobAction, RoleJobRow } from "../types";

export async function enqueueRoleJob(
    guildId: string,
    userId: number,
    roleId: string,
    action: RoleJobAction,
    executeAfter?: Date,
): Promise<void> {
    await query(
        `INSERT INTO bh_role_jobs (guild_id, user_id, role_id, action, execute_after)
         VALUES ($1, $2, $3, $4, COALESCE($5, NOW()))`,
        [guildId, userId, roleId, action, executeAfter ?? null],
    );
}

/**
 * Schedules a role removal, postponing any existing pending removal job for
 * this (guild, user, role) instead of stacking a duplicate — used by the
 * quota reward system to renew F-mode access without an early double-removal.
 */
export async function scheduleRoleRemoval(
    guildId: string,
    userId: number,
    roleId: string,
    executeAfter: Date,
): Promise<void> {
    const result = await query(
        `UPDATE bh_role_jobs SET execute_after = $4, retry_count = 0
         WHERE guild_id = $1 AND user_id = $2 AND role_id = $3 AND action = 'remove' AND processed = FALSE
         RETURNING id`,
        [guildId, userId, roleId, executeAfter],
    );
    if ((result.rowCount ?? 0) === 0) {
        await enqueueRoleJob(guildId, userId, roleId, "remove", executeAfter);
    }
}

export async function getPendingJobs(limit: number): Promise<RoleJobRow[]> {
    const result = await query<RoleJobRow>(
        `SELECT * FROM bh_role_jobs
         WHERE processed = FALSE AND execute_after <= NOW()
         ORDER BY execute_after ASC
         LIMIT $1`,
        [limit],
    );
    return result.rows;
}

export async function markJobProcessed(jobId: number): Promise<void> {
    await query(`UPDATE bh_role_jobs SET processed = TRUE WHERE id = $1`, [jobId]);
}

export async function rescheduleJob(jobId: number, nextRetryCount: number, executeAfter: Date): Promise<void> {
    await query(`UPDATE bh_role_jobs SET retry_count = $2, execute_after = $3 WHERE id = $1`, [
        jobId,
        nextRetryCount,
        executeAfter,
    ]);
}
