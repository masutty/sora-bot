import type { BotClient } from "@/core/BotClient";
import { Logger } from "@/utils/logging";
import { getPendingJobs, markJobProcessed, rescheduleJob } from "../repository/roleJobs";
import { getUserById } from "../repository/users";
import type { RoleJobRow } from "../types";

const logger = new Logger("biomehunt.RoleEngine");

const TICK_INTERVAL_MS = 2_000;
const BATCH_SIZE = 10;
const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 300_000;

/**
 * Backs off (or gives up past MAX_RETRIES) the same way for any failure. `expected` distinguishes
 * a known, recoverable-if-the-bot-rejoins condition (guild not cached) from a genuine bug -
 * only the latter gets logged at `error` level; the guild-gone case is just `debug` noise so it
 * doesn't spam the console/error log forever for a guild the bot was removed from.
 */
async function handleJobFailure(job: RoleJobRow, message: string, expected: boolean): Promise<void> {
    if (job.retry_count + 1 >= MAX_RETRIES) {
        if (expected) logger.debug(`Role job ${job.id} permanently failed (expected): ${message}`);
        else logger.error(new Error(`Role job ${job.id} permanently failed: ${message}`));
        await markJobProcessed(job.id);
    } else {
        const backoffMs = Math.min(BASE_BACKOFF_MS * 2 ** job.retry_count, MAX_BACKOFF_MS);
        await rescheduleJob(job.id, job.retry_count + 1, new Date(Date.now() + backoffMs));
    }
}

async function tick(client: BotClient): Promise<void> {
    const jobs = await getPendingJobs(BATCH_SIZE);

    for (const job of jobs) {
        const guild = client.guilds.cache.get(job.guild_id);
        if (!guild) {
            // Not cached - the bot isn't (or isn't yet) in this guild. Not a bug: back off quietly
            // instead of screaming about it, since it resolves itself if the bot rejoins.
            await handleJobFailure(job, `Guild ${job.guild_id} is not cached`, true);
            continue;
        }

        try {
            const user = await getUserById(job.user_id);
            if (!user) throw new Error(`User ${job.user_id} not found`);

            const member = await guild.members.fetch(user.discord_user_id);
            if (job.action === "add") await member.roles.add(job.role_id);
            else await member.roles.remove(job.role_id);

            await markJobProcessed(job.id);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await handleJobFailure(job, message, false);
        }
    }
}

export function startRoleEngine(client: BotClient): void {
    setInterval(() => {
        tick(client).catch((err) => logger.error(err instanceof Error ? err : new Error(String(err))));
    }, TICK_INTERVAL_MS);
    logger.info(`Role engine started (tick every ${TICK_INTERVAL_MS}ms)`);
}
