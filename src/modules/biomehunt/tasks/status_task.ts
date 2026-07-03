import { Logger } from "@/utils/logging";
import { query } from "../../../database/connection";
import { getGuildConfig } from "../services/GuildConfigCache";
import { RoleManager } from "../services/RoleManager";

const logger = new Logger("biomehunt:status_task");

/* ───────────────────────────────────────────── */
/* Types                                        */
/* ───────────────────────────────────────────── */

type ActivityState = "green" | "yellow" | "red";

interface HeapEntry {
    userId: string;
    guildId: string;
    currentState: ActivityState;
    lastActivity: Date;
    nextCheckAt: number; // ms timestamp
}

interface UserStateRow {
    user_id: string;
    guild_id: string;
    current_state: ActivityState;
    last_activity: string | null;
}

/* ───────────────────────────────────────────── */
/* Min-heap helpers (sorted by nextCheckAt)     */
/* ───────────────────────────────────────────── */

// Simple sorted-insert min-heap.
// For 1000+ users, replace with a proper binary heap.
const heap: HeapEntry[] = [];

function heapInsert(entry: HeapEntry): void {
    const idx = heap.findIndex(e => e.nextCheckAt > entry.nextCheckAt);
    if (idx === -1) heap.push(entry);
    else heap.splice(idx, 0, entry);
}

function heapRemoveUser(userId: string, guildId: string): void {
    const idx = heap.findIndex(
        e => e.userId === userId && e.guildId === guildId,
    );
    if (idx !== -1) heap.splice(idx, 1);
}

/* ───────────────────────────────────────────── */
/* State resolution                             */
/* ───────────────────────────────────────────── */

function resolveState(
    inactiveS: number,
    yellowThresholdS: number,
    redThresholdS: number,
): ActivityState {
    if (inactiveS < yellowThresholdS) return "green";
    if (inactiveS < redThresholdS) return "yellow";
    return "red";
}

/**
 * How many ms until this user's state would change again.
 * Returns a 60s fallback for red (no further transition possible).
 */
function msUntilNextTransition(
    state: ActivityState,
    inactiveMs: number,
    yellowThresholdS: number,
    redThresholdS: number,
): number {
    if (state === "green") return yellowThresholdS * 1000 - inactiveMs;
    if (state === "yellow") return redThresholdS * 1000 - inactiveMs;
    return 60_000;
}

/* ───────────────────────────────────────────── */
/* Heap population                              */
/* ───────────────────────────────────────────── */

async function populateHeap(): Promise<void> {
    const result = await query<UserStateRow>(
        `
        SELECT user_id, guild_id, current_state, last_activity
        FROM bh_user_profiles
        WHERE last_activity IS NOT NULL
        `,
    );

    const now = Date.now();

    for (const row of result.rows) {
        const lastActivity = row.last_activity
            ? new Date(row.last_activity)
            : new Date();

        // Schedule an immediate check so the heap self-corrects on startup
        heapInsert({
            userId: row.user_id,
            guildId: row.guild_id,
            currentState: row.current_state,
            lastActivity,
            nextCheckAt: now,
        });
    }
}

/* ───────────────────────────────────────────── */
/* Public: register a user after /bh setup      */
/* ───────────────────────────────────────────── */

export function registerUser(
    userId: string,
    guildId: string,
    currentState: ActivityState = "red",
): void {
    heapRemoveUser(userId, guildId);
    heapInsert({
        userId,
        guildId,
        currentState,
        lastActivity: new Date(0),
        nextCheckAt: Date.now(),
    });
}

/**
 * Called by ActivityProcessor every time a webhook message arrives.
 * Updates the in-heap entry so the next transition is scheduled correctly.
 */
export function refreshUserActivity(
    userId: string,
    guildId: string,
): void {
    heapRemoveUser(userId, guildId);
    heapInsert({
        userId,
        guildId,
        currentState: "green",   // active → always green
        lastActivity: new Date(),
        nextCheckAt: Date.now() + 10_000, // re-check in 10s minimum
    });
}

/* ───────────────────────────────────────────── */
/* Tick                                         */
/* ───────────────────────────────────────────── */

async function tick(): Promise<void> {
    logger.debug("Tick...");
    const now = Date.now();

    while (heap.length > 0 && heap[0].nextCheckAt <= now) {
        const entry = heap.shift()!;

        const config = await getGuildConfig(entry.guildId);
        if (!config) continue; // guild not configured, skip

        const inactiveMs = now - entry.lastActivity.getTime();
        const inactiveS = inactiveMs / 1000;

        const newState = resolveState(
            inactiveS,
            config.yellowThresholdS,
            config.redThresholdS,
        );

        if (newState !== entry.currentState) {
            // Persist state change
            await query(
                `
                UPDATE bh_user_profiles
                SET current_state = $3, updated_at = NOW()
                WHERE user_id = $1 AND guild_id = $2
                `,
                [entry.userId, entry.guildId, newState],
            );

            RoleManager.enqueue({
                guildId: entry.guildId,
                userId: entry.userId,
                oldState: entry.currentState,
                newState,
                config: {
                    greenRoleId: config.greenRoleId,
                    yellowRoleId: config.yellowRoleId,
                    redRoleId: config.redRoleId,
                },
            });

            entry.currentState = newState;
        }

        // Re-insert with updated nextCheckAt
        const delay = msUntilNextTransition(
            newState,
            inactiveMs,
            config.yellowThresholdS,
            config.redThresholdS,
        );

        entry.nextCheckAt = now + Math.max(delay, 5_000); // never less than 5s
        heapInsert(entry);
    }
}

/* ───────────────────────────────────────────── */
/* Start                                        */
/* ───────────────────────────────────────────── */

const TICK_INTERVAL_MS = 5_000;

export async function startStatusTask(): Promise<void> {
    logger.debug("Starting status task...");
    await populateHeap();
    setInterval(() => tick(), TICK_INTERVAL_MS);
    logger.debug("Status task started! Tick interval: " + TICK_INTERVAL_MS + "ms");
}
