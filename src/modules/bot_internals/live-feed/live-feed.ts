import type { LogEntry } from "@/utils/log-buffer";
import { logBuffer } from "@/utils/log-buffer";
import { getLogLevels, LOG_LEVELS, Logger, type LogLevel } from "@/utils/logging";
import { CEILING_MS, EXTEND_MS, INITIAL_MS, LIVE_FEED_NAMESPACE, TICK_MS } from "./constants";
import type { Destination, FeedFilter } from "./filter";
import { defaultLiteralSecrets } from "./redact";
import { buildClosedPayload, buildFeedPayload, type FeedPayload, selectEntries } from "./render";

const logger = new Logger(LIVE_FEED_NAMESPACE);

/** One message the feed lives in - created by the command, one per destination. */
export interface FeedSurface {
    /** Creates the message; called once by `start`. */
    send(payload: FeedPayload): Promise<void>;
    edit(payload: FeedPayload): Promise<void>;
}

export interface LiveFeedDeps {
    now(): number;
    /** Runs `fn` after `ms`; returns a cancel function. */
    schedule(fn: () => void, ms: number): () => void;
    entries(): readonly LogEntry[];
    globalLevel(): LogLevel;
    literalSecrets(): readonly string[];
    newId(): string;
}

export function defaultLiveFeedDeps(): LiveFeedDeps {
    return {
        now: () => Date.now(),
        schedule: (fn, ms) => {
            const handle = setTimeout(fn, ms);
            return () => clearTimeout(handle);
        },
        entries: () => logBuffer.entries(),
        globalLevel: () => {
            const level = getLogLevels().file;
            return (LOG_LEVELS as readonly string[]).includes(level) ? (level as LogLevel) : "debug";
        },
        literalSecrets: defaultLiteralSecrets,
        // No ":" - the id goes into button customIds.
        newId: () => crypto.randomUUID().slice(0, 8),
    };
}

interface ActiveFeed {
    id: string;
    surface: FeedSurface;
    destination: Destination;
    filter: FeedFilter;
    level: LogLevel;
    expiresAt: number;
    ceilingAt: number;
    cancelTick: () => void;
    cancelExpiry: () => void;
    /** Tail of the feed's serialized edits - an edit never starts before the previous one settles. */
    edits: Promise<void>;
}

/** The single global live log feed. */
export class LiveFeedController {
    private active: ActiveFeed | null = null;

    constructor(private readonly deps: LiveFeedDeps = defaultLiveFeedDeps()) {}

    activeId(): string | null {
        return this.active?.id ?? null;
    }

    render(): FeedPayload | null {
        return this.active ? this.renderFeed(this.active) : null;
    }

    async start(opts: {
        surface: FeedSurface;
        destination: Destination;
        filter: FeedFilter;
        level: LogLevel;
        startedAt?: number;
    }): Promise<string> {
        await this.endActive("replaced");

        const now = this.deps.now();
        const { startedAt = now, ...rest } = opts;
        const feed: ActiveFeed = {
            id: this.deps.newId(),
            ...rest,
            expiresAt: now + INITIAL_MS,
            ceilingAt: startedAt + CEILING_MS,
            cancelTick: () => {},
            cancelExpiry: () => {},
            edits: Promise.resolve(),
        };
        // A rejection propagates and leaves no active feed.
        await feed.surface.send(this.renderFeed(feed));

        // Overlapping starts finished first: close them all (re-checking after each await) so no live message is left behind.
        while (this.active) await this.end(this.active, "replaced");

        this.active = feed;
        this.scheduleTick(feed);
        this.scheduleExpiry(feed);
        logger.info(`Live feed ${feed.id} started (${feed.destination}, level ${feed.level})`);
        return feed.id;
    }

    async extend(feedId: string): Promise<boolean> {
        const feed = this.active;
        if (!feed || feed.id !== feedId || feed.expiresAt >= feed.ceilingAt) return false;

        feed.expiresAt = Math.min(feed.expiresAt + EXTEND_MS, feed.ceilingAt);
        feed.cancelExpiry();
        this.scheduleExpiry(feed);
        logger.verbose(`Live feed ${feed.id} extended`);
        await this.refresh(feed);
        return true;
    }

    async stop(feedId: string, reason: string): Promise<boolean> {
        const feed = this.active;
        if (!feed || feed.id !== feedId) return false;
        await this.end(feed, reason);
        return true;
    }

    async endActive(reason: string): Promise<void> {
        while (this.active) await this.end(this.active, reason);
    }

    private renderFeed(feed: ActiveFeed): FeedPayload {
        return buildFeedPayload({
            feedId: feed.id,
            entries: selectEntries(this.deps.entries(), feed.filter, feed.level, LIVE_FEED_NAMESPACE),
            filter: feed.filter,
            level: feed.level,
            globalLevel: this.deps.globalLevel(),
            expiresAt: feed.expiresAt,
            ceilingAt: feed.ceilingAt,
            now: this.deps.now(),
            redactWith: feed.destination === "channel" ? this.deps.literalSecrets() : null,
        });
    }

    private scheduleTick(feed: ActiveFeed): void {
        feed.cancelTick = this.deps.schedule(() => {
            void this.tick(feed);
        }, TICK_MS);
    }

    private scheduleExpiry(feed: ActiveFeed): void {
        const ms = Math.max(feed.expiresAt - this.deps.now(), 0);
        feed.cancelExpiry = this.deps.schedule(() => {
            void this.end(feed, "timed out");
        }, ms);
    }

    private async tick(feed: ActiveFeed): Promise<void> {
        if (this.active !== feed) return;
        if (this.deps.now() >= feed.expiresAt) {
            await this.end(feed, "timed out");
            return;
        }
        this.scheduleTick(feed);
        await this.refresh(feed);
    }

    /** Queues an edit behind the feed's earlier ones; `payload` is built when its turn comes. */
    private queueEdit(feed: ActiveFeed, payload: () => FeedPayload | null): Promise<void> {
        const run = feed.edits.then(() => {
            const next = payload();
            return next ? feed.surface.edit(next) : undefined;
        });
        feed.edits = run.catch(() => {});
        return run;
    }

    /** Edits the feed message; a failed edit ends the feed and tries the closed edit once, best-effort. */
    private async refresh(feed: ActiveFeed): Promise<void> {
        try {
            // Once the feed ended, a queued live edit is dropped so it can never land after the closed one.
            await this.queueEdit(feed, () => (this.active === feed ? this.renderFeed(feed) : null));
        } catch (error) {
            if (this.active !== feed) return;
            this.clear(feed);
            logger.info(`Live feed ${feed.id} ended: edit failed (${error instanceof Error ? error.message : String(error)})`);
            // The live content must not stay up in the channel: one closed edit, no retry loop.
            await this.queueEdit(feed, () => buildClosedPayload("edit failed")).catch(() => {});
        }
    }

    private clear(feed: ActiveFeed): void {
        feed.cancelTick();
        feed.cancelExpiry();
        if (this.active === feed) this.active = null;
    }

    /** Idempotent: only the first end for a feed does anything. */
    private async end(feed: ActiveFeed, reason: string): Promise<void> {
        if (this.active !== feed) return;
        this.clear(feed);
        logger.info(`Live feed ${feed.id} ended: ${reason}`);
        try {
            await this.queueEdit(feed, () => buildClosedPayload(reason));
        } catch (error) {
            logger.verbose(`Live feed ${feed.id} closed edit failed (${error instanceof Error ? error.message : String(error)})`);
        }
    }
}

export const liveFeed = new LiveFeedController();
