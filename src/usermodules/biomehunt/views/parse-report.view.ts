import {
    AttachmentBuilder,
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    type MessageComponentInteraction,
    MessageFlags,
    SeparatorSpacingSize,
} from "discord.js";
import { tabs } from "@/core/view/tabs";
import type { ViewDefinition } from "@/define";
import { formatCodeblock, NO_PINGS } from "@/utils/format";
import type { ExtractionStep } from "../macro-parsers";
import type { ChannelIndexEntry } from "../repository/users.repository";
import { inline, KINDS, mark, type ReportSubject, reportKind } from "./parse-report.kinds";

const MAX_STEPS = 8;
const MAX_TEXT = 300;
/** Discord's limit for a Link button URL. */
const MAX_URL = 512;

export interface ParseReportData extends ReportSubject {
    webhookId: string | null;
    /** The tracked macro channel the message is in, if any. */
    tracked: ChannelIndexEntry | null;
    /** The channel's owner. */
    memberId: string | null;
    url: string;
    messageId: string;
    /** The message's embeds and components, as JSON. */
    raw: string;
}

export type ParseReportState = ParseReportData & { tab: string };

/** Macro text inside a code block, cut to size and unable to close the block. */
function quote(text: string): string {
    const cut = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
    return formatCodeblock(cut.replaceAll("```", "ˋˋˋ"), "");
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

function detectionGroups(data: ParseReportData): string[] {
    const { inspection, tracked, memberId } = data;
    return [
        [
            "**Channel**",
            `- ${mark(tracked !== null)} Tracked macro channel`,
            ...(memberId ? [`> <@${memberId}>`] : []),
            `- ${mark(tracked !== null && tracked.webhookId === data.webhookId)} Webhook matches`,
            `> ${inline(data.webhookId ?? "not a webhook")}`,
        ].join("\n"),
        [
            "**Detection**",
            `- **Parser:** ${inline(inspection.parserId ?? "none")}`,
            `- **Footer:** ${inline(inspection.footer ?? "none")}`,
            `- **Author:** ${inline(inspection.author ?? "none")}`,
            `- **Input:** \`${inspection.input}\``,
            KINDS[reportKind(data)].read(data),
            `- **Server link:** ${inspection.serverLink ? inline(inspection.serverLink, 200) : "none"}`,
        ].join("\n"),
    ];
}

const textGroups = ({ inspection }: ParseReportData): string[] =>
    inspection.steps.length > 0 ? inspection.steps.slice(0, MAX_STEPS).map(describeStep) : ["❌ No text to read"];

const PAGES: Record<string, { label: string; groups: (data: ParseReportData) => string[] }> = {
    detection: { label: "Detection", groups: detectionGroups },
    find: { label: "Find", groups: (data) => KINDS[reportKind(data)].find(data) },
    votes: { label: "Votes", groups: (data) => KINDS[reportKind(data)].votes(data) },
    texts: { label: "Texts read", groups: textGroups },
};

/** `/owner parse`: what detection makes of a message and what came of it, one page per question. */
export function parseReportView(): ViewDefinition<ParseReportState, void, ParseReportData> {
    return tabs<ParseReportState, ParseReportData>({
        name: "biomehunt.parse-report",
        initial: (data) => ({ ...data, tab: "detection" }),
        tabs: Object.entries(PAGES).map(([key, { label }]) => ({ key, label })),
        renderTab: (state, kit) => {
            const { label, color } = KINDS[reportKind(state)].verdict(state);
            const container = new ContainerBuilder().setAccentColor(color);
            [`**Macro parse**\n${label}\n${state.url}`, ...(PAGES[state.tab]?.groups(state) ?? [])].forEach((text, i) => {
                if (i > 0) container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
                container.addTextDisplayComponents((td) => td.setContent(text));
            });

            const link = state.inspection.serverLink;
            return {
                payload: { flags: MessageFlags.IsComponentsV2, components: [container], allowedMentions: NO_PINGS },
                extraRows: [
                    kit.row(
                        kit.button("raw", (b) => b.setLabel("Raw JSON")),
                        ...(link && link.length <= MAX_URL
                            ? [new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Join server").setURL(link)]
                            : []),
                    ),
                ],
            };
        },
        on: {
            // `c.notify` is text only, so the file goes through the raw interaction (see `bot_internals.trace`).
            raw: async (c) => {
                const file = new AttachmentBuilder(Buffer.from(c.state.raw), { name: `message-${c.state.messageId}.json` });
                await (c.raw as MessageComponentInteraction).reply({
                    files: [file],
                    flags: MessageFlags.Ephemeral,
                    allowedMentions: NO_PINGS,
                });
            },
        },
    });
}
