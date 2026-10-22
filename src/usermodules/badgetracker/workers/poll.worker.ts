import type { BotClient } from "@/core/bot-client";
import { defineWorker } from "@/define";
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

let tick: (() => Promise<void>) | null = null;

export const pollWorker = defineWorker({
    name: "poll",
    intervalMs: settings.workers.pollTickMs,
    runOnStart: true,
    async run(client: BotClient) {
        tick ??= createPollTick({
            now: () => new Date(),
            getSettings: getTrackerSettings,
            setLastRoundAt,
            runRound: (ms) => runRound(defaultPollerDeps(client, ms)),
        });
        await tick();
    },
});
