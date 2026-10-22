import { describe, expect, test } from "bun:test";
import type { LogEntry } from "@/utils/log-buffer";
import { CEILING_MS, EXTEND_MS, INITIAL_MS, TICK_MS } from "./constants";
import { parseFilter } from "./filter";
import { type FeedSurface, LiveFeedController, type LiveFeedDeps } from "./live-feed";
import type { FeedPayload } from "./render";

const START = 1_000_000_000_000;

function harness(entries: LogEntry[] = [], tickDrift = 0) {
    let clock = START;
    let ids = 0;
    const timers: { at: number; fn: () => void; cancelled: boolean }[] = [];
    const deps: LiveFeedDeps = {
        now: () => clock,
        schedule: (fn, ms) => {
            const timer = { at: clock + ms + (ms === TICK_MS ? tickDrift : 0), fn, cancelled: false };
            timers.push(timer);
            return () => {
                timer.cancelled = true;
            };
        },
        entries: () => entries,
        globalLevel: () => "info",
        literalSecrets: () => [],
        newId: () => `id${++ids}`,
    };
    /** Moves the clock forward, running due timers in order (timers they create run too if due). */
    async function advance(ms: number) {
        const target = clock + ms;
        for (;;) {
            const due = timers.filter((t) => !t.cancelled && t.at <= target).sort((a, b) => a.at - b.at)[0];
            if (!due) break;
            due.cancelled = true;
            clock = Math.max(clock, due.at);
            due.fn();
            await new Promise((r) => setImmediate(r));
        }
        clock = target;
    }
    return { deps, advance, now: () => clock };
}

function surface(failOnEdit?: number) {
    const sent: FeedPayload[] = [];
    const edits: FeedPayload[] = [];
    const s: FeedSurface = {
        async send(p) {
            sent.push(p);
        },
        async edit(p) {
            edits.push(p);
            if (failOnEdit !== undefined && edits.length === failOnEdit) throw new Error("edit failed");
        },
    };
    return { s, sent, edits };
}

const json = (p: FeedPayload) => JSON.stringify(p.components.map((c) => c.toJSON()));
const opts = (s: FeedSurface, destination: "ephemeral" | "dm" | "channel" = "ephemeral") => ({
    surface: s,
    destination,
    filter: parseFilter(null),
    level: "info" as const,
});

describe("LiveFeedController", () => {
    test("start renders immediately and expires after 60s", async () => {
        const h = harness();
        const ctl = new LiveFeedController(h.deps);
        const { s, sent, edits } = surface();
        const id = await ctl.start(opts(s));
        expect(sent).toHaveLength(1);
        expect(ctl.activeId()).toBe(id);
        await h.advance(INITIAL_MS);
        expect(ctl.activeId()).toBeNull();
        expect(json(edits[edits.length - 1])).toContain("Live feed closed · timed out");
    });

    test("extend adds 30s and caps at 14 min", async () => {
        const h = harness();
        const ctl = new LiveFeedController(h.deps);
        const { s } = surface();
        const id = await ctl.start(opts(s));
        const results: boolean[] = [];
        for (let i = 0; i < 40; i++) results.push(await ctl.extend(id));
        const trueCount = results.filter(Boolean).length;
        expect(trueCount).toBe((CEILING_MS - INITIAL_MS) / EXTEND_MS);
        expect(results[trueCount - 1]).toBe(true);
        expect(results[trueCount]).toBe(false);
        await h.advance(CEILING_MS - 1);
        expect(ctl.activeId()).toBe(id);
        await h.advance(1);
        expect(ctl.activeId()).toBeNull();
    });

    test("starting a second feed closes the first as replaced", async () => {
        const h = harness();
        const ctl = new LiveFeedController(h.deps);
        const a = surface();
        const b = surface();
        await ctl.start(opts(a.s));
        const idB = await ctl.start(opts(b.s));
        expect(json(a.edits[a.edits.length - 1])).toContain("closed · replaced");
        expect(json(b.sent[0])).not.toContain("closed");
        expect(ctl.activeId()).toBe(idB);
    });

    test("edit failure ends quietly", async () => {
        const h = harness();
        const ctl = new LiveFeedController(h.deps);
        const { s, edits } = surface(2);
        await ctl.start(opts(s));
        await h.advance(30_000);
        expect(ctl.activeId()).toBeNull();
        // The failed live edit, then one best-effort closed edit - and no retry loop after that.
        expect(edits).toHaveLength(3);
        expect(json(edits[2])).toContain("Live feed closed · edit failed");
        await h.advance(60_000);
        expect(edits).toHaveLength(3);
    });

    test("a failing closed edit after an edit failure is swallowed", async () => {
        const h = harness();
        const ctl = new LiveFeedController(h.deps);
        const edits: FeedPayload[] = [];
        const s: FeedSurface = {
            send: async () => {},
            edit: async (p) => {
                edits.push(p);
                throw new Error("down");
            },
        };
        await ctl.start(opts(s));
        await h.advance(30_000);
        expect(ctl.activeId()).toBeNull();
        expect(edits).toHaveLength(2);
    });

    test("the ceiling counts from startedAt", async () => {
        const h = harness();
        const ctl = new LiveFeedController(h.deps);
        const { s } = surface();
        const startedAt = START - 5_000;
        const id = await ctl.start({ ...opts(s), startedAt });
        while (await ctl.extend(id));
        await h.advance(CEILING_MS - 5_000 - 1);
        expect(ctl.activeId()).toBe(id);
        await h.advance(1);
        expect(ctl.activeId()).toBeNull();
    });

    test("send failure propagates and leaves no active feed", async () => {
        const h = harness();
        const ctl = new LiveFeedController(h.deps);
        const s: FeedSurface = {
            send: async () => {
                throw new Error("nope");
            },
            edit: async () => {},
        };
        await expect(ctl.start(opts(s))).rejects.toThrow("nope");
        expect(ctl.activeId()).toBeNull();
    });

    test("channel destination redacts, dm does not", async () => {
        const entries: LogEntry[] = [{ level: "info", namespace: "a", text: "user 188851299255713792 did x" }];
        const h = harness(entries);
        const ctl = new LiveFeedController(h.deps);
        const ch = surface();
        await ctl.start(opts(ch.s, "channel"));
        expect(json(ch.sent[0])).not.toContain("188851299255713792");
        expect(json(ch.sent[0])).toContain("1888████3792");
        const dm = surface();
        await ctl.start(opts(dm.s, "dm"));
        expect(json(dm.sent[0])).toContain("188851299255713792");
    });

    test("stop with a stale id returns false and does nothing", async () => {
        const h = harness();
        const ctl = new LiveFeedController(h.deps);
        const { s, edits } = surface();
        const id = await ctl.start(opts(s));
        expect(await ctl.stop("other", "stopped")).toBe(false);
        expect(ctl.activeId()).toBe(id);
        expect(edits).toHaveLength(0);
        expect(await ctl.stop(id, "stopped")).toBe(true);
        expect(await ctl.stop(id, "stopped")).toBe(false);
        expect(edits).toHaveLength(1);
    });

    test("render returns null when idle", () => {
        expect(new LiveFeedController(harness().deps).render()).toBeNull();
    });

    test("exact expiry closes at expiresAt, not at the next tick", async () => {
        // Ticks drift 7ms late each round, so the tick grid never lines up with the expiry.
        const h = harness([], 7);
        const ctl = new LiveFeedController(h.deps);
        const { s, edits } = surface();
        await ctl.start(opts(s));
        await h.advance(INITIAL_MS - 1);
        expect(ctl.activeId()).not.toBeNull();
        await h.advance(1);
        expect(ctl.activeId()).toBeNull();
        expect(json(edits[edits.length - 1])).toContain("timed out");
    });

    test("overlapping starts leave exactly one live feed", async () => {
        const h = harness();
        const ctl = new LiveFeedController(h.deps);
        let release: () => void = () => {};
        const a = surface();
        const slowSend = a.s.send.bind(a.s);
        a.s.send = async (p) => {
            await new Promise<void>((r) => {
                release = r;
            });
            await slowSend(p);
        };
        const b = surface();
        const startA = ctl.start(opts(a.s));
        await Promise.resolve();
        const idB = await ctl.start(opts(b.s));
        release();
        const idA = await startA;
        expect(ctl.activeId()).toBe(idA);
        expect(idA).not.toBe(idB);
        expect(json(b.edits[b.edits.length - 1])).toContain("closed · replaced");
        expect(a.edits).toHaveLength(0);
    });

    test("three overlapping starts leave exactly one live feed", async () => {
        const h = harness();
        const ctl = new LiveFeedController(h.deps);
        const releases: (() => void)[] = [];
        const surfaces = [surface(), surface(), surface()];
        for (const x of surfaces) {
            const slowSend = x.s.send.bind(x.s);
            x.s.send = async (p) => {
                await new Promise<void>((r) => releases.push(r));
                await slowSend(p);
            };
        }
        const starts = surfaces.map((x) => ctl.start(opts(x.s)));
        await new Promise((r) => setImmediate(r));
        expect(releases).toHaveLength(3);
        for (const release of releases) release();
        const ids = await Promise.all(starts);
        const live = surfaces.filter((x) => x.edits.every((e) => !json(e).includes("closed")));
        expect(live).toHaveLength(1);
        expect(ctl.activeId()).not.toBeNull();
        expect(ids).toContain(ctl.activeId() as string);
        expect(surfaces.filter((x) => x.edits.some((e) => json(e).includes("closed · replaced")))).toHaveLength(2);
    });

    test("a slow live edit never lands after the closed one", async () => {
        const h = harness();
        const ctl = new LiveFeedController(h.deps);
        const applied: FeedPayload[] = [];
        let release: () => void = () => {};
        let calls = 0;
        const s: FeedSurface = {
            send: async () => {},
            edit: async (p) => {
                if (++calls === 1) {
                    await new Promise<void>((r) => {
                        release = r;
                    });
                }
                applied.push(p);
            },
        };
        const id = await ctl.start(opts(s));
        await h.advance(5_000); // tick edit now pending
        const stopping = ctl.stop(id, "stopped");
        await Promise.resolve();
        release();
        await stopping;
        expect(json(applied[applied.length - 1])).toContain("closed · stopped");
        expect(applied.filter((p) => json(p).includes("closed"))).toHaveLength(1);
    });

    test("extend whose refresh edit fails ends the feed and still returns true", async () => {
        const h = harness();
        const ctl = new LiveFeedController(h.deps);
        const { s } = surface(1);
        const id = await ctl.start(opts(s));
        expect(await ctl.extend(id)).toBe(true);
        expect(ctl.activeId()).toBeNull();
    });

    test("endActive when idle is a no-op", async () => {
        const ctl = new LiveFeedController(harness().deps);
        await ctl.endActive("bot shutdown");
        expect(ctl.activeId()).toBeNull();
    });
});
