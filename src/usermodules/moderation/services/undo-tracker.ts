import { Logger } from "@/utils/logging";
import { UNDO_WINDOW_S } from "./undo";

const logger = new Logger("moderation.undo");

export interface PostRef {
    channelId: string;
    messageId: string;
}

/**
 * Remembers, in memory only, the Created posts that still carry an undo button. A restart loses the
 * map; the click checks still guard.
 */
export function createUndoTracker(removeButton: (ref: PostRef) => Promise<void>, ttlMs = UNDO_WINDOW_S * 1000) {
    const posts = new Map<string, { ref: PostRef; timer: ReturnType<typeof setTimeout> }>();

    /** Forgets the Case and takes the button off its post (best effort). */
    async function release(caseId: string): Promise<void> {
        const entry = posts.get(caseId);
        if (!entry) return;
        clearTimeout(entry.timer);
        posts.delete(caseId);
        try {
            await removeButton(entry.ref);
        } catch (err) {
            logger.debug(`Could not remove the undo button of ${caseId}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    return {
        remember(caseId: string, ref: PostRef): void {
            const old = posts.get(caseId);
            if (old) clearTimeout(old.timer);
            const timer = setTimeout(() => void release(caseId), ttlMs);
            timer.unref();
            posts.set(caseId, { ref, timer });
        },
        release,
        has: (caseId: string): boolean => posts.has(caseId),
    };
}

export type UndoTracker = ReturnType<typeof createUndoTracker>;
