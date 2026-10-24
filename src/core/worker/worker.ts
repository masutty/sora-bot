/**
 * `defineWorker` - the framework owns periodic work. A module declares WHAT to do and how often;
 * the cog loader (`startWorker`, called from `registerCog`/`unloadCog`) owns the loop itself: no
 * module writes its own `setInterval` anymore.
 */
import { Logger } from "@/utils/logging";
import { newTraceRef, runWithTrace } from "@/utils/trace";
import type { BotClient } from "../bot-client";

const logger = new Logger("core.worker");

/**
 * A periodic background task, declared with `defineWorker`. A cog lists these in `workers: [...]`
 * (see `Cog.workers`); the framework starts each one when its cog loads and stops it on
 * unload/hot reload/reload - never call `startWorker` from a module directly.
 */
export interface WorkerDefinition {
    /** Unique within its cog - used in the trace command (`worker:<cog>.<name>`) and in logs. */
    name: string;
    /** Tick period, in ms. */
    intervalMs: number;
    /** One tick's work. */
    run: (client: BotClient) => void | Promise<void>;
    /** Also run once immediately when started, instead of waiting for the first `intervalMs`. Default false. */
    runOnStart?: boolean;
}

/**
 * Declares a worker - see `WorkerDefinition`. A no-op today (returns `def` unchanged); exists so
 * modules have one place to import from (`@/define`) and so the shape can grow without every cog
 * needing to change.
 */
export function defineWorker(def: WorkerDefinition): WorkerDefinition {
    return def;
}

/** Injectable for tests (a manual clock); the default is the real timers. */
export interface WorkerClock {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}

const realClock: WorkerClock = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** What a running worker has done so far - read by `!bot workers` and `!bot status`. */
export interface WorkerStats {
    cog: string;
    name: string;
    intervalMs: number;
    startedAt: Date;
    /** Ticks finished, failed ones included. */
    runs: number;
    running: boolean;
    lastRunAt: Date | null;
    lastDurationMs: number | null;
    /** The last failure - cleared by the next tick that succeeds. */
    lastError: { message: string; at: Date } | null;
    /** Ticks skipped because the previous one was still running. */
    skipped: number;
}

const stats = new Map<string, WorkerStats>();

/** Every running worker's stats, by cog then name. */
export function listWorkerStats(): WorkerStats[] {
    return [...stats.values()].sort((a, b) => a.cog.localeCompare(b.cog) || a.name.localeCompare(b.name));
}

/** Handle returned by `startWorker` - stops the loop for good (no further ticks). */
export interface RunningWorker {
    stop(): void;
}

/**
 * Starts one worker's loop for `cogName` - called by the cog loader on load (and never again by a
 * module directly). Guarantees:
 * - Fixed-period ticking: a tick fires every `intervalMs`, regardless of how long the previous one took.
 * - No overlapping runs: if a tick is still running when the next is due, that due tick is
 *   SKIPPED (not queued) - the loop simply waits for the following one.
 * - A `run` that throws/rejects is logged and does NOT stop the loop.
 * - A run that takes longer than `intervalMs` logs a warn (the bot may be falling behind).
 * - Every run happens inside `runWithTrace({ ref: newTraceRef(), command: "worker:<cog>.<name>" })`.
 */
export function startWorker(cogName: string, worker: WorkerDefinition, client: BotClient, clock: WorkerClock = realClock): RunningWorker {
    const label = `${cogName}.${worker.name}`;
    let stopped = false;
    let running = false;
    let handle: unknown = null;
    const stat: WorkerStats = {
        cog: cogName,
        name: worker.name,
        intervalMs: worker.intervalMs,
        startedAt: new Date(),
        runs: 0,
        running: false,
        lastRunAt: null,
        lastDurationMs: null,
        lastError: null,
        skipped: 0,
    };
    stats.set(label, stat);

    const runTick = async (): Promise<void> => {
        if (running) {
            stat.skipped++;
            return;
        }
        running = true;
        stat.running = true;
        const startedAt = Date.now();
        let failure: Error | null = null;
        try {
            await runWithTrace({ ref: newTraceRef(), command: `worker:${label}` }, async () => {
                await worker.run(client);
            });
        } catch (err) {
            failure = err instanceof Error ? err : new Error(String(err));
            logger.error(failure, { worker: label });
        } finally {
            running = false;
            const durationMs = Date.now() - startedAt;
            stat.running = false;
            stat.runs++;
            stat.lastRunAt = new Date(startedAt);
            stat.lastDurationMs = durationMs;
            stat.lastError = failure ? { message: failure.message, at: new Date() } : null;
            if (durationMs > worker.intervalMs) {
                logger.warn(`Worker ${label} tick took ${durationMs}ms (interval is ${worker.intervalMs}ms) - may be falling behind`);
            }
        }
    };

    const scheduleNext = (): void => {
        if (stopped) return;
        handle = clock.setTimeout(() => {
            scheduleNext();
            void runTick();
        }, worker.intervalMs);
    };

    scheduleNext();
    if (worker.runOnStart) void runTick();

    return {
        stop() {
            stopped = true;
            if (stats.get(label) === stat) stats.delete(label);
            if (handle !== null) clock.clearTimeout(handle);
        },
    };
}
