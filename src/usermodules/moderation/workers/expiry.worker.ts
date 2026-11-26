import type { BotClient } from "@/core/bot-client";
import { defineWorker } from "@/define";
import { Logger } from "@/utils/logging";
import type { CaseRow } from "../types";

const logger = new Logger("moderation.workers.expiry");

export const EXPIRY_BATCH = 50;

/** What a tick needs, injected so tests use neither the database nor Discord. */
export interface ExpiryDeps {
    now(): Date;
    dueCases(now: Date, limit: number): Promise<CaseRow[]>;
    expire(row: CaseRow): Promise<unknown>;
}

/** Ends every due case; one failing case is logged and never stops the rest of the batch. */
export function createExpiryTick(deps: ExpiryDeps): () => Promise<void> {
    return async () => {
        for (const row of await deps.dueCases(deps.now(), EXPIRY_BATCH)) {
            try {
                await deps.expire(row);
            } catch (err) {
                logger.error(err instanceof Error ? err : new Error(String(err)), { caseId: row.id });
            }
        }
    };
}

/** The cog wires the real deps; the tick is built once on the first run. */
export function expiryWorker(getDeps: (client: BotClient) => ExpiryDeps) {
    let tick: (() => Promise<void>) | null = null;
    return defineWorker({
        name: "expiry",
        intervalMs: 60_000,
        runOnStart: true,
        run: async (client) => {
            tick ??= createExpiryTick(getDeps(client));
            await tick();
        },
    });
}
