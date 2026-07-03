// modules/biomehunter/services/StateEngine.ts
// Instead of checking ALL users every tick,
// maintain a priority queue sorted by nextEventAt.
// Only the top of the heap needs to be checked.

import { RoleManager } from "./RoleManager";
import { getGuildConfig, GuildConfig } from "./GuildConfigCache";

type ActivityState = "green" | "yellow" | "red";

interface UserStateEntry {
    userId: string;
    guildId: string;
    currentState: ActivityState;
    lastActivity: Date;
    nextEventAt: Date; // when this user's state should be re-evaluated
}

export class StateEngine {
    // Simple sorted array (replace with a real min-heap for 1000+ users)
    private static heap: UserStateEntry[] = [];

    static async tick(): Promise<void> {
        const now = new Date();

        while (this.heap.length > 0 && this.heap[0].nextEventAt <= now) {
            const entry = this.heap.shift()!;
            await this.evaluateUser(entry, now);
        }
    }

    private static async evaluateUser(entry: UserStateEntry, now: Date): Promise<void> {
        const config = await getGuildConfig(entry.guildId);
        if (!config) return;

        const inactiveMs = now.getTime() - entry.lastActivity.getTime();
        const inactiveS = inactiveMs / 1000;

        let newState: ActivityState;
        if (inactiveS < config.yellowThresholdS) {
            newState = "green";
        } else if (inactiveS < config.redThresholdS) {
            newState = "yellow";
        } else {
            newState = "red";
        }

        if (newState !== entry.currentState) {
            // Only queue a Discord API call if state actually changed
            await RoleManager.enqueue({
                guildId: entry.guildId,
                userId: entry.userId,
                oldState: entry.currentState,
                newState,
                config,
            });

            entry.currentState = newState;
        }

        // Re-insert with updated nextEventAt
        const nextCheckMs = this.getNextCheckMs(newState, inactiveMs, config);
        entry.nextEventAt = new Date(now.getTime() + nextCheckMs);
        this.insertSorted(entry);
    }

    private static getNextCheckMs(
        state: ActivityState,
        inactiveMs: number,
        config: { yellowThresholdS: number; redThresholdS: number }
    ): number {
        if (state === "green") {
            // Check again when yellow threshold would be hit
            return config.yellowThresholdS * 1000 - inactiveMs;
        }
        if (state === "yellow") {
            return config.redThresholdS * 1000 - inactiveMs;
        }
        return 60_000; // red: check every minute (no further transitions)
    }

    private static insertSorted(entry: UserStateEntry): void {
        const idx = this.heap.findIndex(e => e.nextEventAt > entry.nextEventAt);
        if (idx === -1) this.heap.push(entry);
        else this.heap.splice(idx, 0, entry);
    }
}
