import { describe, expect, test } from "bun:test";
import type { LogEntry } from "@/utils/log-buffer";
import { LIVE_FEED_NAMESPACE, MAX_LINES } from "./constants";
import { parseFilter } from "./filter";
import { buildClosedPayload, buildFeedPayload, type FeedView, fitEntries, selectEntries } from "./render";

const NOW = 1_000_000_000_000;

function entry(text: string, namespace: string | null = "a", level: LogEntry["level"] = "info"): LogEntry {
    return { level, namespace, text };
}

function view(overrides: Partial<FeedView> = {}): FeedView {
    return {
        feedId: "f1",
        entries: [entry("hello")],
        filter: parseFilter(null),
        level: "info",
        globalLevel: "info",
        expiresAt: NOW + 60_000,
        ceilingAt: NOW + 14 * 60_000,
        now: NOW,
        redactWith: [],
        ...overrides,
    };
}

// biome-ignore lint/suspicious/noExplicitAny: inspecting raw component JSON
type Json = any;

function texts(json: Json): string[] {
    return (json.components as Json[]).filter((c) => c.type === 10).map((c) => c.content as string);
}

function buttons(json: Json): Json[] {
    return (json.components as Json[]).filter((c) => c.type === 1).flatMap((row) => row.components as Json[]);
}

describe("fitEntries", () => {
    test("keeps only whole newest entries under maxLines", () => {
        const out = fitEntries(["a", "b\nb\nb", "c\nc"], 5, 1000);
        expect(out).toEqual(["b\nb\nb", "c\nc"]);
    });

    test("respects maxChars the same way", () => {
        const out = fitEntries(["aaaa", "bbbb", "cccc"], 30, 9);
        expect(out).toEqual(["bbbb", "cccc"]);
    });

    test("truncates a single oversized newest entry", () => {
        const out = fitEntries(["x".repeat(10_000)], 30, 3800);
        expect(out).toHaveLength(1);
        expect(out[0].length).toBeLessThanOrEqual(3800);
        expect(out[0].startsWith("…")).toBe(true);
    });

    test("a cut tail never starts on a lone low surrogate", () => {
        // 100 emoji = 200 code units; with maxChars 100 the raw cut would start inside a pair.
        const out = fitEntries(["😀".repeat(100)], 30, 100);
        expect(out[0].codePointAt(1)).toBe(0x1f600);
    });

    test("returns [] for empty input", () => {
        expect(fitEntries([], 30, 3800)).toEqual([]);
    });
});

describe("selectEntries", () => {
    test("drops the feed's own namespace even at verbose", () => {
        const all = [entry("own", LIVE_FEED_NAMESPACE, "verbose"), entry("other", "a", "verbose")];
        const out = selectEntries(all, parseFilter(null), "verbose", LIVE_FEED_NAMESPACE);
        expect(out.map((e) => e.text)).toEqual(["other"]);
    });

    test("applies level and filter", () => {
        const all = [entry("1", "a", "debug"), entry("2", "b", "error"), entry("3", "a", "info")];
        const out = selectEntries(all, parseFilter("a"), "info", LIVE_FEED_NAMESPACE);
        expect(out.map((e) => e.text)).toEqual(["3"]);
    });
});

describe("buildFeedPayload", () => {
    test("stays under the text budget and exposes the buttons", () => {
        const entries = Array.from({ length: 1000 }, (_, i) => entry(`line ${i} ${"y".repeat(200)}`));
        const payload = buildFeedPayload(view({ entries }));
        const container = payload.components[0].toJSON() as Json;
        const total = texts(container).reduce((n, t) => n + t.length, 0);
        expect(total).toBeLessThan(4000);
        expect(buttons(container).map((b) => b.custom_id)).toEqual([
            "bot_internals:livefeed:f1:stop",
            "bot_internals:livefeed:f1:extend",
            "bot_internals:livefeed:f1:buffer",
        ]);
    });

    test("shows a placeholder when empty", () => {
        const container = buildFeedPayload(view({ entries: [] })).components[0].toJSON() as Json;
        expect(texts(container).join("\n")).toContain("(no entries yet)");
    });

    test("warning state changes accent, extend style and footer", () => {
        const container = buildFeedPayload(view({ expiresAt: NOW + 10_000 })).components[0].toJSON() as Json;
        expect(container.accent_color).toBe(0xfee75c);
        expect(buttons(container)[1].style).toBe(3);
        expect(texts(container).join("\n")).toContain("⚠️ closes");
    });

    test("normal state uses the normal accent and Secondary extend", () => {
        const container = buildFeedPayload(view()).components[0].toJSON() as Json;
        expect(container.accent_color).toBe(0x5865f2);
        expect(buttons(container)[1].style).toBe(2);
        expect(buttons(container)[0].style).toBe(4);
    });

    test("extend is disabled at the ceiling", () => {
        const container = buildFeedPayload(view({ expiresAt: NOW + 60_000, ceilingAt: NOW + 60_000 })).components[0].toJSON() as Json;
        expect(buttons(container)[1].disabled).toBe(true);
    });

    test("warns when the global level hides the feed level", () => {
        const container = buildFeedPayload(view({ level: "verbose", globalLevel: "debug" })).components[0].toJSON() as Json;
        expect(texts(container).join("\n")).toContain("global is debug, verbose won't arrive");
    });

    test("redacts the code block when redactWith is set, raw otherwise", () => {
        const entries = [entry("conn postgres://a:b@h/db ok")];
        const redacted = buildFeedPayload(view({ entries, filter: parseFilter("x"), redactWith: [] })).components[0].toJSON() as Json;
        const text = texts(redacted).join("\n");
        expect(text).toContain("████████");
        expect(text).not.toContain("a:b@");
        const raw = buildFeedPayload(view({ entries, redactWith: null })).components[0].toJSON() as Json;
        expect(texts(raw).join("\n")).toContain("postgres://a:b@h/db");
    });

    test("redacts the footer too", () => {
        const container = buildFeedPayload(
            view({ filter: parseFilter("postgres://a:b@h/db"), redactWith: [] }),
        ).components[0].toJSON() as Json;
        expect(texts(container).join("\n")).not.toContain("a:b@");
    });
});

describe("buildFeedPayload limits", () => {
    test("a huge filter cannot push the message past 4000 characters", () => {
        const entries = Array.from({ length: 1000 }, (_, i) => entry(`line ${i} ${"y".repeat(200)}`));
        const container = buildFeedPayload(view({ entries, filter: parseFilter("n".repeat(5000)) })).components[0].toJSON() as Json;
        const total = texts(container).reduce((n, t) => n + t.length, 0);
        expect(total).toBeLessThan(4000);
    });

    test("runs of four or more backticks cannot close the code block", () => {
        const container = buildFeedPayload(view({ entries: [entry("a ```` b ````` c")] })).components[0].toJSON() as Json;
        const block = texts(container)[0];
        const body = block.slice(8, -4);
        expect(body).not.toContain("```");
    });
});

describe("buildClosedPayload", () => {
    test("has no code block and no action row", () => {
        const payload = buildClosedPayload("stopped");
        const json = payload.components[0].toJSON() as Json;
        const text = texts(json).join("\n");
        expect(text).toContain("🔴 Live feed closed · stopped");
        expect(text).not.toContain("```ansi");
        expect(buttons(json)).toHaveLength(0);
        expect(JSON.stringify(json)).not.toContain('"type":1,');
    });
});

describe("buildFeedPayload performance", () => {
    test("channel redaction only touches the entries that can be shown, once each", () => {
        // `redact` calls `filter` once per call, so counting it counts redactions.
        let calls = 0;
        const secrets = Object.assign([] as string[], {
            filter: () => {
                calls++;
                return [];
            },
        });
        // Long entries force the shrink loop to run more than once.
        const entries = Array.from({ length: 1000 }, () => entry("a ".repeat(500)));
        buildFeedPayload(view({ entries, redactWith: secrets }));
        // The footer is masked too (one call).
        expect(calls).toBeLessThanOrEqual(MAX_LINES + 1);
    });
});
