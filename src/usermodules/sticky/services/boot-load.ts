/** Waits before retry n (0-based): 5s, 30s, 2m, then 5m. */
export const LOAD_RETRY_MS = [5_000, 30_000, 120_000, 300_000];

export const MAX_LOAD_ATTEMPTS = 10;

export interface BootLoadDeps {
    load(): Promise<void>;
    sleep(ms: number): Promise<void>;
    logError(err: Error): void;
    logInfo(message: string): void;
}

/** Runs `load` until it succeeds, at most `MAX_LOAD_ATTEMPTS` times. Returns whether it loaded. */
export async function loadWithRetry(deps: BootLoadDeps): Promise<boolean> {
    for (let attempt = 0; attempt < MAX_LOAD_ATTEMPTS; attempt++) {
        try {
            await deps.load();
            return true;
        } catch (err) {
            deps.logError(err instanceof Error ? err : new Error(String(err)));
            if (attempt === MAX_LOAD_ATTEMPTS - 1) break;
            const wait = LOAD_RETRY_MS[Math.min(attempt, LOAD_RETRY_MS.length - 1)] as number;
            deps.logInfo(`Could not load stickies. Retrying in ${wait / 1000}s.`);
            await deps.sleep(wait);
        }
    }
    deps.logError(new Error(`Could not load stickies after ${MAX_LOAD_ATTEMPTS} attempts. The sticky module stays inert until restart.`));
    return false;
}
