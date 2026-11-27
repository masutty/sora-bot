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
import { formatCodeblock, formatTime, NO_PINGS, unix } from "@/utils/format";
import type { ExtractionStep, MessageInspection } from "../macro-parsers";
import type { RecordedEvent } from "../repository/activity.repository";
import type { MerchantEventRow } from "../repository/merchant-events.repository";
import type { ChannelIndexEntry } from "../repository/users.repository";
import type { FindRecord, Tally } from "../services/find-record.service";

const MAX_STEPS = 8;
const MAX_TEXT = 300;
/** Discord's limit for a Link button URL. */
const MAX_URL = 512;

export interface ParseReportData {
    inspection: MessageInspection;
    webhookId: string | null;
    /** The tracked macro channel the message is in, if any. */
    tracked: ChannelIndexEntry | null;
    /** The channel's owner. */
    memberId: string | null;
    url: string;
    messageId: string;
    /** What detection stored for this message when it arrived. */
    recorded: RecordedEvent | null;
    record: FindRecord;
    /** The merchant find stored for this message, if it was one. */
    merchantEvent?: MerchantEventRow | null;
    /** The message's embeds and components, as JSON. */
    raw: string;
}

export type ParseReportState = ParseReportData & { tab: string };

const mark = (ok: boolean) => (ok ? "✅" : "❌");
const inline = (text: string, max = 100) => `\`${text.slice(0, max).replaceAll("`", "ˋ")}\``;
const when = (date: Date) => `<t:${unix(date)}:f>`;
const words = (status: string) => status.replaceAll("_", " ");
const postLink = (guildId: string, channelId: string, messageId: string) =>
    `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
const tallyLine = ({ real, fake }: Tally) => `- **Ballots:** ✅ ${real} real, ❌ ${fake} fake`;
/** A titled list, or the title with a single "none" line. */
const group = (title: string, lines: Array<string | null> | null, none: string) =>
    [`**${title}**`, ...(lines ? lines.filter((line) => line !== null) : [`❌ ${none}`])].join("\n");

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

/** What the message means to detection, with the accent color that goes with it. */
function verdict({ event, checkpoint }: MessageInspection): { label: string; color: number } {
    if (event?.eventType === "started") return { label: "✅ Biome start", color: 0x248046 };
    if (checkpoint) {
        const merchant = checkpoint.merchant ? `merchant ${checkpoint.merchant}` : "merchant, name not read";
        return { label: `✅ Checkpoint (${checkpoint.kind === "normal" ? "normal biome" : merchant})`, color: 0x5865f2 };
    }
    if (event) return { label: event.eventType ? "✅ Biome end" : "⚠️ Biome with no event type", color: 0xf0b232 };
    return { label: "❌ Nothing read", color: 0xda373c };
}

function detectionGroups(data: ParseReportData): string[] {
    const { inspection, tracked, memberId } = data;
    const { event, checkpoint, serverLink } = inspection;
    const biome = event ?? (checkpoint?.biome ? checkpoint : null);
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
            `- **Biome:** ${biome ? `\`${biome.biome}\` (${biome.eventType ?? "no event type"})` : "none"}`,
            `- **Server link:** ${serverLink ? inline(serverLink, 200) : "none"}`,
        ].join("\n"),
    ];
}

function findGroups({ recorded, record, merchantEvent }: ParseReportData): string[] {
    const { session, reward } = record;
    return [
        ...(merchantEvent
            ? [
                  group(
                      "Merchant",
                      [
                          `- **Find:** \`#${merchantEvent.id}\` ${inline(merchantEvent.merchant)}`,
                          `- **Parser:** ${inline(merchantEvent.macro_type ?? "none")}`,
                          `- **When:** ${when(merchantEvent.received_at)}`,
                      ],
                      "No merchant stored",
                  ),
              ]
            : []),
        group(
            "Event",
            recorded && [
                `- **Event:** \`#${recorded.id}\` ${inline(recorded.biome ?? "no biome")} (${recorded.event_type ?? "no event type"})`,
                `- **Parser:** ${inline(recorded.macro_type ?? "none")}`,
                `- **When:** ${when(recorded.received_at)}`,
            ],
            "No biome event stored",
        ),
        group(
            "Session",
            session && [
                `- **Session:** \`#${session.id}\` ${formatTime(session.duration_seconds)}`,
                `- **Started:** ${when(session.started_at)}`,
                `- ${mark(session.counted)} Counts in stats`,
            ],
            "No session found",
        ),
        group(
            "Given to the member",
            reward && [
                `- **Seeds:** ${reward.seeds_awarded}`,
                `- **XP:** ${reward.xp_awarded}`,
                `- **Badge:** ${reward.badge_awarded ? inline(reward.badge_awarded) : "none"}`,
            ],
            "No reward recorded",
        ),
    ];
}

function voteGroups({ record }: ParseReportData): string[] {
    const { vote, casual, network } = record;
    return [
        group(
            "Local vote",
            vote && [
                `- **Vote:** \`${vote.row.id}\` ${words(vote.row.status)}`,
                tallyLine(vote.tally),
                vote.row.decided_by ? `- **Decided by:** <@${vote.row.decided_by}>` : null,
                vote.row.status === "open" ? `- **Closes:** <t:${unix(vote.row.closes_at)}:R>` : null,
                `- **Post:** ${postLink(vote.row.guild_id, vote.row.channel_id, vote.row.message_id)}`,
            ],
            "No vote",
        ),
        group(
            "Forward buttons",
            casual && [
                tallyLine(casual.tally),
                `- **Post:** ${postLink(casual.row.guild_id, casual.row.channel_id, casual.row.message_id)}`,
            ],
            "No casual vote",
        ),
        group(
            "Network",
            network && [
                `- **Post:** \`${network.post.id}\` ${words(network.post.status)}`,
                `- **Vote:** ${words(network.post.vote_status)}`,
                tallyLine(network.tally),
                `- **Servers reached:** ${network.mirrors}`,
                network.post.vote_decided_by ? `- **Decided by:** <@${network.post.vote_decided_by}>` : null,
            ],
            "Not sent to the Network",
        ),
    ];
}

const textGroups = ({ inspection }: ParseReportData): string[] =>
    inspection.steps.length > 0 ? inspection.steps.slice(0, MAX_STEPS).map(describeStep) : ["❌ No text to read"];

const PAGES: Record<string, { label: string; groups: (data: ParseReportData) => string[] }> = {
    detection: { label: "Detection", groups: detectionGroups },
    find: { label: "Find", groups: findGroups },
    votes: { label: "Votes", groups: voteGroups },
    texts: { label: "Texts read", groups: textGroups },
};

/** `/owner parse`: what detection makes of a message and what came of it, one page per question. */
export function parseReportView(): ViewDefinition<ParseReportState, void, ParseReportData> {
    return tabs<ParseReportState, ParseReportData>({
        name: "biomehunt.parse-report",
        initial: (data) => ({ ...data, tab: "detection" }),
        tabs: Object.entries(PAGES).map(([key, { label }]) => ({ key, label })),
        renderTab: (state, kit) => {
            const { label, color } = verdict(state.inspection);
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
