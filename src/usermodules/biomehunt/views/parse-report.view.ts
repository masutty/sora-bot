import { EmbedBuilder } from "discord.js";
import type { ExtractionStep, MessageInspection } from "../macro-parsers";
import type { RecordedEvent } from "../repository/activity.repository";
import type { ChannelIndexEntry } from "../repository/users.repository";

const MAX_STEPS = 8;
const MAX_TEXT = 300;

export interface ParseReportSource {
    webhookId: string | null;
    /** The tracked macro channel the message is in, if any. */
    tracked: ChannelIndexEntry | null;
    url: string;
    /** What detection stored for this message when it arrived. */
    recorded: RecordedEvent | null;
}

const mark = (ok: boolean) => (ok ? "✅" : "❌");

function describeRecorded(event: RecordedEvent | null): string {
    if (!event) return "no";
    const at = Math.floor(event.received_at.getTime() / 1000);
    return `\`#${event.id}\` \`${event.biome ?? "no biome"}\` (${event.event_type ?? "no event type"}, ${event.macro_type ?? "no macro"}) <t:${at}:T>`;
}

/** Macro text inside a code block, cut to size and unable to close the block. */
function quote(text: string): string {
    const cut = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
    return `\`\`\`\n${cut.replaceAll("```", "ˋˋˋ")}\n\`\`\``;
}

function describeStep(step: ExtractionStep): string {
    const result =
        step.outcome === "matched"
            ? `✅ \`${step.biome}\` (${step.eventType ?? "no event type"})`
            : step.outcome === "unknown-biome"
              ? `⚠️ unknown biome \`${step.biome}\``
              : "❌ no match";
    return `**${step.source}** ${result}\n${quote(step.text)}`;
}

/** What detection makes of a message, step by step. */
export function buildParseReport(inspection: MessageInspection, source: ParseReportSource): EmbedBuilder {
    const { event } = inspection;
    const webhookMatches = source.tracked !== null && source.tracked.webhookId === source.webhookId;
    const isStart = event?.eventType === "started";

    const summary = [
        `- Message: ${source.url}`,
        `- ${mark(source.tracked !== null)} Tracked macro channel`,
        `- ${mark(webhookMatches)} Webhook matches (\`${source.webhookId ?? "not a webhook"}\`)`,
        `- Input: \`${inspection.input}\``,
        `- Parser: \`${inspection.parserId ?? "none"}\``,
        `- Footer: \`${(inspection.footer ?? "none").slice(0, 100).replaceAll("`", "ˋ")}\``,
        `- Biome: ${event ? `\`${event.biome}\` (${event.eventType ?? "no event type"})` : "none"}`,
        `- Server link: ${inspection.serverLink ? `\`${inspection.serverLink.slice(0, 200)}\`` : "none"}`,
        `- ${mark(isStart)} Biome start`,
        `- ${mark(inspection.merchant)} Merchant`,
        `- Recorded: ${describeRecorded(source.recorded)}`,
    ];

    return new EmbedBuilder()
        .setColor(isStart ? 0x248046 : event ? 0xf0b232 : 0xda373c)
        .setTitle("Macro parse")
        .setDescription([summary.join("\n"), ...inspection.steps.slice(0, MAX_STEPS).map(describeStep)].join("\n\n").slice(0, 4096));
}
