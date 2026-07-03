import type { BotClient } from "../../../core/BotClient";


/* ───────────────────────────────────────────── */
/* Types                                        */
/* ───────────────────────────────────────────── */

interface RoleUpdateJob {
    guildId: string;
    userId: string;
    oldState: string;
    newState: string;
    config: {
        greenRoleId: string | null | undefined;
        yellowRoleId: string | null | undefined;
        redRoleId: string | null | undefined;
    };
}

/* ───────────────────────────────────────────── */
/* RoleManager                                  */
/* ───────────────────────────────────────────── */

const DRAIN_INTERVAL_MS = 200; // ~5 role updates/s, under Discord's guild limit
const RETRY_DELAY_MS = 1_000;
const MAX_RETRIES = 3;

export class RoleManager {
    private static pending = new Map<string, RoleUpdateJob>();
    private static processing = false;
    private static client: BotClient;

    static init(client: BotClient): void {
        this.client = client;
    }

    /**
     * Enqueues a role swap. If a pending update already exists for this user
     * it is replaced — no point assigning YELLOW then immediately RED.
     */
    static enqueue(job: RoleUpdateJob): void {
        this.pending.set(`${job.guildId}:${job.userId}`, job);
    }

    /**
     * Drains the queue one job at a time, 200 ms apart.
     * Called by the drain interval started in init().
     */
    static async drain(): Promise<void> {
        if (this.processing || this.pending.size === 0) return;
        this.processing = true;

        for (const [key, job] of this.pending) {
            this.pending.delete(key);
            await this.applyRoleSwap(job);
            await sleep(DRAIN_INTERVAL_MS);
        }

        this.processing = false;
    }

    private static async applyRoleSwap(job: RoleUpdateJob): Promise<void> {
        const roleMap: Record<string, string | null | undefined> = {
            green: job.config.greenRoleId,
            yellow: job.config.yellowRoleId,
            red: job.config.redRoleId,
        };

        const oldRoleId = roleMap[job.oldState];
        const newRoleId = roleMap[job.newState];

        // Nothing to do if both sides are unconfigured
        if (!oldRoleId && !newRoleId) return;

        let attempts = 0;

        while (attempts < MAX_RETRIES) {
            try {
                const guild = await this.client.guilds.fetch(job.guildId);
                const member = await guild.members.fetch(job.userId);

                if (oldRoleId) await member.roles.remove(oldRoleId);
                if (newRoleId) await member.roles.add(newRoleId);

                return;
            } catch (err: unknown) {
                attempts++;

                // 429 = rate limited — back off and retry
                if (isRateLimitError(err) && attempts < MAX_RETRIES) {
                    await sleep(RETRY_DELAY_MS * attempts);
                    continue;
                }

                console.error(
                    `[RoleManager] failed for ${job.userId} in ${job.guildId} ` +
                    `(attempt ${attempts}/${MAX_RETRIES}):`,
                    err,
                );
                return;
            }
        }
    }
}

/* ───────────────────────────────────────────── */
/* Helpers                                      */
/* ───────────────────────────────────────────── */

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isRateLimitError(err: unknown): boolean {
    return (
        typeof err === "object" &&
        err !== null &&
        "httpStatus" in err &&
        (err as { httpStatus: number }).httpStatus === 429
    );
}
