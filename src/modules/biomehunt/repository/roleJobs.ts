import { query } from "@/database/connection";
import type { RoleJobAction, RoleJobRow } from "../types";

export async function enqueueRoleJob(
    guildId: string,
    userId: number,
    roleId: string,
    action: RoleJobAction,
): Promise<void> {
    await query(
        `INSERT INTO bh_role_jobs (guild_id, user_id, role_id, action) VALUES ($1, $2, $3, $4)`,
        [guildId, userId, roleId, action],
    );
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
