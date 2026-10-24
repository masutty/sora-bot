import { ContainerBuilder, SeparatorSpacingSize } from "discord.js";
import type { WorkerStats } from "@/core/worker/worker";
import { formatTime } from "@/utils/format";

const unix = (date: Date) => Math.floor(date.getTime() / 1000);

/** One worker: state, name, period and how its last run went. The error text only shows where only the owner sees it. */
export function workerLine(w: WorkerStats, showErrors: boolean, now = Date.now()): string {
    const head = `**${w.name}** · every ${formatTime(w.intervalMs / 1000)}`;
    if (w.running) return `⏳ ${head} · running now`;
    if (w.lastError) {
        const why = showErrors ? `: ${w.lastError.message.slice(0, 120)}` : "";
        return `❌ ${head} · failed <t:${unix(w.lastError.at)}:R>${why}`;
    }
    if (!w.lastRunAt) return `⚪ ${head} · not run yet`;
    // A run older than 3 periods means the loop stalled - the timer should have fired again by now.
    const stale = now - w.lastRunAt.getTime() > w.intervalMs * 3 ? " ⚠️" : "";
    const skipped = w.skipped > 0 ? ` · ${w.skipped} skipped` : "";
    return `✅ ${head} · <t:${unix(w.lastRunAt)}:R> in ${w.lastDurationMs}ms${skipped}${stale}`;
}

/** `!bot workers`: every running worker, grouped by cog. */
export function buildWorkersContainer(workers: WorkerStats[], showErrors: boolean): ContainerBuilder {
    const container = new ContainerBuilder().setAccentColor(0x5865f2);
    container.addTextDisplayComponents((td) => td.setContent("## ⚙️ Workers"));
    if (workers.length === 0) {
        container.addTextDisplayComponents((td) => td.setContent("No workers running."));
        return container;
    }
    for (const cog of new Set(workers.map((w) => w.cog))) {
        container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
        const lines = workers.filter((w) => w.cog === cog).map((w) => workerLine(w, showErrors));
        container.addTextDisplayComponents((td) => td.setContent([`**${cog}**`, ...lines].join("\n")));
    }
    return container;
}
