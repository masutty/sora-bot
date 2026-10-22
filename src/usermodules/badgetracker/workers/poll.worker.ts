import type { BotClient } from "@/core/bot-client";
import { defineWorker } from "@/define";
import { Logger } from "@/utils/logging";
import { getTrackerSettings, setLastRoundAt } from "../repository/settings.repository";
import { defaultPollerDeps, type RoundResult, runRound } from "../services/poller.service";
import { settings } from "../settings";
import type { TrackerSettingsRow } from "../types";

export interface PollTickDeps {
    now(): Date;
    getSettings(): Promise<TrackerSettingsRow>;
    setLastRoundAt(at: Date): Promise<void>;
    runRound(intervalMs: number): Promise<RoundResult>;
}

/**
 * Builds the worker tick. The worker interval is fixed, so the tick itself decides whether a round is due:
 * it waits out the configured interval and any rate-limit pause. Backoff state lives in this closure.
 */
export function createPollTick(deps: PollTickDeps): () => Promise<void> {
    let pausedUntilMs = 0;
    let consecutiveLimits = 0;

    return async () => {
        const startedAt = deps.now();
        if (startedAt.getTime() < pausedUntilMs) return;

        const tracker = await deps.getSettings();
        const intervalMs = tracker.interval_minutes * 60_000;
        if (tracker.last_round_at && startedAt.getTime() - tracker.last_round_at.getTime() < intervalMs) return;

        await deps.setLastRoundAt(startedAt);
        const result = await deps.runRound(intervalMs);

        if (result.kind === "done") {
            consecutiveLimits = 0;
            pausedUntilMs = 0;
            return;
        }
        const wait = result.retryAfterMs ?? Math.min(settings.roblox.backoffBaseMs * 2 ** consecutiveLimits, settings.roblox.backoffMaxMs);
        consecutiveLimits++;
        pausedUntilMs = deps.now().getTime() + wait;
    };
}

const logger = new Logger("badge-tracker.poll");

/**
 * Wraps a tick so it runs in the background: a round can outlast the worker tick, and awaiting it
 * would trigger the scheduler's slow-tick warning on every round. Skips while a previous tick runs.
 */
export function createBackgroundRunner(tick: () => Promise<void>, onError: (err: unknown) => void): () => void {
    let inFlight = false;
    return () => {
        if (inFlight) return;
        inFlight = true;
        tick()
            .catch(onError)
            .finally(() => {
                inFlight = false;
            });
    };
}

let runner: (() => void) | null = null;

export const pollWorker = defineWorker({
    name: "poll",
    intervalMs: settings.workers.pollTickMs,
    runOnStart: true,
    async run(client: BotClient) {
        runner ??= createBackgroundRunner(
            createPollTick({
                now: () => new Date(),
                getSettings: getTrackerSettings,
                setLastRoundAt,
                runRound: (ms) => runRound(defaultPollerDeps(client, ms)),
            }),
            (err) => logger.error("Poll tick failed", { error: err instanceof Error ? err.message : String(err) }),
        );
        runner();
    },
});
