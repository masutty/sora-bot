import type * as limitsRepo from "../repository/limits.repository";
import type * as stickiesRepo from "../repository/stickies.repository";
import { settings } from "../settings";
import { StickyError, type StickyMode, type StickyRow } from "../types";
import type { PostResult, Reposter } from "./repost.service";
import { stickyCache } from "./sticky-cache";

/** The saved sticky, and whether its post went out. A failed post keeps the row. */
export type SaveOutcome = ({ posted: true } | { posted: false; reason: string }) & { sticky: StickyRow };

/** The line shown when a sticky was saved: `success` when posted, else the reason it was not. */
export function savedLine(outcome: SaveOutcome, success: string): string {
    if (outcome.posted) return success;
    return `Sticky saved for <#${outcome.sticky.channel_id}>, but I couldn't post it: ${outcome.reason.replace(/\.$/, "")}.`;
}

export interface StickyService {
    overview(guildId: string): Promise<{ stickies: StickyRow[]; used: number; limit: number }>;
    create(input: {
        guildId: string;
        channelId: string;
        content: string;
        mode?: StickyMode;
        delaySeconds?: number;
        userId: string;
    }): Promise<SaveOutcome>;
    editContent(channelId: string, content: string): Promise<SaveOutcome>;
    setMode(channelId: string, mode: StickyMode): Promise<StickyRow>;
    setDelay(channelId: string, seconds: number): Promise<StickyRow>;
    remove(channelId: string): Promise<void>;
    get(channelId: string): StickyRow | undefined;
}

export interface StickyServiceDeps {
    repo: typeof stickiesRepo;
    limits: Pick<typeof limitsRepo, "getGuildLimit">;
    reposter: Reposter;
    removeMessage(channelId: string, messageId: string): Promise<void>;
}

const NO_STICKY = "This channel has no sticky.";
const ALREADY_HAS = "This channel already has a sticky. Use `/sticky edit`.";

export function createStickyService(deps: StickyServiceDeps): StickyService {
    const { repo, limits, reposter } = deps;

    async function patch(channelId: string, changes: Parameters<typeof stickiesRepo.updateSticky>[1]): Promise<StickyRow> {
        const row = await repo.updateSticky(channelId, changes);
        if (!row) {
            stickyCache.delete(channelId);
            throw new StickyError(NO_STICKY);
        }
        const merged = { ...(stickyCache.get(channelId) ?? row), ...changes };
        stickyCache.set(merged);
        return merged;
    }

    const outcome = (row: StickyRow, result: PostResult): SaveOutcome => ({ ...result, sticky: stickyCache.get(row.channel_id) ?? row });

    return {
        async overview(guildId) {
            const [stickies, limit] = await Promise.all([repo.listGuildStickies(guildId), limits.getGuildLimit(guildId)]);
            return { stickies, used: stickies.length, limit };
        },

        async create({ guildId, channelId, content, mode, delaySeconds, userId }) {
            if (mode !== undefined && !(settings.modes as readonly string[]).includes(mode))
                throw new StickyError("Pick one of the listed modes.");
            if (delaySeconds !== undefined && !(settings.delaysSeconds as readonly number[]).includes(delaySeconds))
                throw new StickyError("Pick one of the listed delays.");
            if (stickyCache.get(channelId)) throw new StickyError(ALREADY_HAS);
            const [used, limit] = await Promise.all([repo.countGuildStickies(guildId), limits.getGuildLimit(guildId)]);
            if (used >= limit) throw new StickyError(`This server is at its sticky limit (${used}/${limit}).`);
            let row: StickyRow;
            try {
                row = await repo.insertSticky({
                    guild_id: guildId,
                    channel_id: channelId,
                    content,
                    mode: mode ?? settings.defaultMode,
                    delay_seconds: delaySeconds ?? settings.defaultDelaySeconds,
                    created_by: userId,
                });
            } catch (err) {
                if ((err as { code?: string }).code === "23505") throw new StickyError(ALREADY_HAS);
                throw err;
            }
            stickyCache.set(row);
            return outcome(row, await reposter.postNow(row));
        },

        async editContent(channelId, content) {
            const row = await patch(channelId, { content });
            return outcome(row, await reposter.postNow(row));
        },

        setMode: (channelId, mode) => patch(channelId, { mode }),

        async setDelay(channelId, seconds) {
            if (!(settings.delaysSeconds as readonly number[]).includes(seconds)) throw new StickyError("Pick one of the listed delays.");
            return patch(channelId, { delay_seconds: seconds });
        },

        async remove(channelId) {
            const row = await repo.deleteSticky(channelId);
            const messageId = row?.message_id ?? stickyCache.get(channelId)?.message_id ?? null;
            stickyCache.delete(channelId);
            if (messageId) await deps.removeMessage(channelId, messageId).catch(() => {});
        },

        get: (channelId) => stickyCache.get(channelId),
    };
}
