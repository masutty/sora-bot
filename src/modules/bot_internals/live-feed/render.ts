import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, MessageFlags, SeparatorSpacingSize } from "discord.js";
import type { LogEntry } from "@/utils/log-buffer";
import type { LogLevel } from "@/utils/logging";
import { ACCENT_NORMAL, ACCENT_WARNING, MAX_CHARS, MAX_LINES, WARNING_MS } from "./constants";
import { type FeedFilter, formatFilter, levelAllows, matchesFilter } from "./filter";
import { redact } from "./redact";

export const LIVE_FEED_PREFIX = "bot_internals:livefeed";

/** Discord caps the text of a Components V2 message at 4000 characters in total. */
const TEXT_BUDGET = 4000;
/** Longest filter text shown in the footer. */
const FILTER_MAX_CHARS = 200;

const ANSI_CODES: Record<LogLevel, number> = { error: 31, warn: 33, info: 32, debug: 34, verbose: 30 };

export interface FeedView {
    feedId: string;
    entries: readonly LogEntry[];
    filter: FeedFilter;
    level: LogLevel;
    globalLevel: LogLevel;
    expiresAt: number;
    ceilingAt: number;
    now: number;
    /** Literal secrets to mask; `null` means raw output (DM / ephemeral). */
    redactWith: readonly string[] | null;
}

export interface FeedPayload {
    components: ContainerBuilder[];
    flags: MessageFlags.IsComponentsV2;
}

/** Entries visible to the feed: right level, matching the filter, never the feed's own logs. */
export function selectEntries(all: readonly LogEntry[], f: FeedFilter, min: LogLevel, selfNamespace: string): LogEntry[] {
    return all.filter((e) => e.namespace !== selfNamespace && levelAllows(min, e.level) && matchesFilter(e.namespace, f));
}

/** Keeps the newest whole entries that fit both limits (oldest -> newest in and out). */
export function fitEntries(entries: readonly string[], maxLines: number, maxChars: number): string[] {
    const kept: string[] = [];
    let lines = 0;
    let chars = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
        const entryLines = entries[i].split("\n").length;
        const nextChars = chars + entries[i].length + (kept.length > 0 ? 1 : 0);
        if (lines + entryLines > maxLines || nextChars > maxChars) break;
        kept.unshift(entries[i]);
        lines += entryLines;
        chars = nextChars;
    }
    if (kept.length > 0 || entries.length === 0) return kept;

    // The newest entry alone is too big: keep its tail.
    const tail = entries[entries.length - 1].split("\n").slice(-maxLines).join("\n");
    let cut = tail.slice(-(maxChars - 1));
    // Don't start on the second half of a surrogate pair.
    if (/^[\uDC00-\uDFFF]/.test(cut)) cut = cut.slice(1);
    return [`…${cut}`];
}

export function ansiColor(level: LogLevel, text: string): string {
    const code = ANSI_CODES[level];
    return text
        .split("\n")
        .map((line) => `\u001b[${code}m${line}\u001b[0m`)
        .join("\n");
}

/** Keeps user-supplied text from blowing the message's character budget. */
function capText(text: string): string {
    return text.length > FILTER_MAX_CHARS ? `${text.slice(0, FILTER_MAX_CHARS - 1)}…` : text;
}

function buildFooter(v: FeedView, warning: boolean): string {
    const mask = (s: string) => (v.redactWith ? redact(s, v.redactWith) : s);
    const closes = `${warning ? "⚠️ " : ""}closes <t:${Math.floor(v.expiresAt / 1000)}:R>`;
    let footer = `-# filter: ${capText(mask(formatFilter(v.filter)))} · level: ${v.level} · ${closes}`;
    if (!levelAllows(v.globalLevel, v.level)) footer += ` · ⚠️ global is ${v.globalLevel}, ${v.level} won't arrive`;
    return footer;
}

interface RenderedEntry {
    level: LogLevel;
    text: string;
}

/** Redacts and fence-proofs the entries that can be shown; runs once per render, not once per shrink pass. */
function renderEntries(v: FeedView): RenderedEntry[] {
    // Each entry takes at least one line, so only the last MAX_LINES can ever be shown - older ones are never redacted.
    return v.entries.slice(-MAX_LINES).map((e) => {
        // A literal fence inside a log line would end the code block early.
        const text = (v.redactWith ? redact(e.text, v.redactWith) : e.text).replace(/`{3,}/g, (run) => run.split("").join("​"));
        return { level: e.level, text };
    });
}

function buildBlock(rendered: readonly RenderedEntry[], maxChars: number): string {
    // fitEntries works on plain text; map back to the entries it kept (always a suffix).
    const fitted = fitEntries(
        rendered.map((r) => r.text),
        MAX_LINES,
        maxChars,
    );
    const offset = rendered.length - fitted.length;
    const body = fitted.map((text, i) => ansiColor(rendered[offset + i].level, text)).join("\n");
    return `\`\`\`ansi\n${body || "(no entries yet)"}\n\`\`\``;
}

export function buildFeedPayload(v: FeedView): FeedPayload {
    const warning = v.expiresAt - v.now <= WARNING_MS;
    const footer = buildFooter(v, warning);
    const rendered = renderEntries(v);

    // ANSI escapes count toward Discord's text limit, so shrink the log budget until everything fits.
    let maxChars = MAX_CHARS;
    let block = buildBlock(rendered, maxChars);
    while (block.length + footer.length >= TEXT_BUDGET && maxChars > 100) {
        maxChars -= block.length + footer.length - TEXT_BUDGET + 50;
        block = buildBlock(rendered, Math.max(maxChars, 100));
    }

    const atCeiling = v.expiresAt >= v.ceilingAt;
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`${LIVE_FEED_PREFIX}:${v.feedId}:stop`).setLabel("⏹ Stop").setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId(`${LIVE_FEED_PREFIX}:${v.feedId}:extend`)
            .setLabel("+30s")
            .setStyle(warning ? ButtonStyle.Success : ButtonStyle.Secondary)
            .setDisabled(atCeiling),
        new ButtonBuilder().setCustomId(`${LIVE_FEED_PREFIX}:${v.feedId}:buffer`).setLabel("📥 Buffer").setStyle(ButtonStyle.Secondary),
    );

    const container = new ContainerBuilder().setAccentColor(warning ? ACCENT_WARNING : ACCENT_NORMAL);
    container.addTextDisplayComponents((td) => td.setContent(block));
    container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    container.addTextDisplayComponents((td) => td.setContent(footer));
    container.addActionRowComponents(row);

    return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

export function buildClosedPayload(reason: string): FeedPayload {
    const container = new ContainerBuilder().setAccentColor(ACCENT_NORMAL);
    container.addTextDisplayComponents((td) => td.setContent(`🔴 Live feed closed · ${reason}`));
    return { components: [container], flags: MessageFlags.IsComponentsV2 };
}
