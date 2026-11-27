/**
 * What `/owner parse` says about each kind of macro report. A new kind is one entry in `KINDS` and
 * one line in `reportKind` - the View only draws what they describe.
 */
import { formatTime, unix } from "@/utils/format";
import { formatBiomeName } from "../constants/biomes.constants";
import { merchantTarget } from "../constants/merchants.constants";
import type { MessageInspection } from "../macro-parsers";
import type { RecordedEvent } from "../repository/activity.repository";
import type { MerchantEventRow } from "../repository/merchant-events.repository";
import type { FindRecord, Tally } from "../services/find-record.service";

export type ReportKind = "biome" | "merchant" | "normal" | "nothing";

/** What a kind is told from: the message as read now, and what was stored when it arrived. */
export interface ReportSubject {
    inspection: MessageInspection;
    recorded: RecordedEvent | null;
    record: FindRecord;
    /** The merchant find stored for this message, if it was one. */
    merchantEvent?: MerchantEventRow | null;
}

export interface KindDescription {
    /** The line under the report's title, and the accent color that goes with it. */
    verdict(subject: ReportSubject): { label: string; color: number };
    /** The `Detection` line saying what was read. */
    read(subject: ReportSubject): string;
    find(subject: ReportSubject): string[];
    votes(subject: ReportSubject): string[];
}

const GREEN = 0x248046;
const BLUE = 0x5865f2;
const ORANGE = 0xf0b232;
const RED = 0xda373c;

export const mark = (ok: boolean) => (ok ? "✅" : "❌");
export const inline = (text: string, max = 100) => `\`${text.slice(0, max).replaceAll("`", "ˋ")}\``;
const when = (date: Date) => `<t:${unix(date)}:f>`;
const words = (status: string) => status.replaceAll("_", " ");
const postLink = (guildId: string, channelId: string, messageId: string) =>
    `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
const tallyLine = ({ real, fake }: Tally) => `- **Ballots:** ✅ ${real} real, ❌ ${fake} fake`;
const merchantName = (key: string) => formatBiomeName(merchantTarget(key));
/** A titled list, or the title with a single "none" line. */
const group = (title: string, lines: Array<string | null> | null, none: string) =>
    [`**${title}**`, ...(lines ? lines.filter((line) => line !== null) : [`❌ ${none}`])].join("\n");

const biomeLine = ({ inspection }: ReportSubject) => {
    const read = inspection.event ?? (inspection.checkpoint?.biome ? inspection.checkpoint : null);
    return `- **Biome:** ${read ? `\`${read.biome}\` (${read.eventType ?? "no event type"})` : "none"}`;
};

const sessionGroup = ({ record: { session } }: ReportSubject) =>
    group(
        "Session",
        session && [
            `- **Session:** \`#${session.id}\` ${formatTime(session.duration_seconds)}`,
            `- **Started:** ${when(session.started_at)}`,
            `- ${mark(session.counted)} Counts in stats`,
        ],
        "No session found",
    );

const buttonsGroup = ({ record: { casual } }: ReportSubject) =>
    group(
        "Forward buttons",
        casual && [tallyLine(casual.tally), `- **Post:** ${postLink(casual.row.guild_id, casual.row.channel_id, casual.row.message_id)}`],
        "No casual vote",
    );

const biome: KindDescription = {
    verdict: ({ inspection: { event } }) => {
        if (event?.eventType === "started") return { label: "✅ Biome start", color: GREEN };
        if (event) return { label: event.eventType ? "✅ Biome end" : "⚠️ Biome with no event type", color: ORANGE };
        // Stored when it arrived, but not read anymore (a disabled biome, a changed parser).
        return { label: "⚠️ Stored as a biome, not read now", color: ORANGE };
    },
    read: biomeLine,
    find: (subject) => {
        const { recorded, record } = subject;
        const { reward } = record;
        return [
            group(
                "Event",
                recorded && [
                    `- **Event:** \`#${recorded.id}\` ${inline(recorded.biome ?? "no biome")} (${recorded.event_type ?? "no event type"})`,
                    `- **Parser:** ${inline(recorded.macro_type ?? "none")}`,
                    `- **When:** ${when(recorded.received_at)}`,
                ],
                "No biome event stored",
            ),
            sessionGroup(subject),
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
    },
    votes: (subject) => {
        const { vote, network } = subject.record;
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
            buttonsGroup(subject),
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
    },
};

/** The merchant read now, or else the one stored when the message arrived. */
const merchantOf = ({ inspection, merchantEvent }: ReportSubject) => inspection.checkpoint?.merchant ?? merchantEvent?.merchant ?? null;

const merchant: KindDescription = {
    verdict: (subject) => {
        const key = merchantOf(subject);
        return { label: `✅ Merchant ${key ? merchantName(key) : "(name not read)"}`, color: BLUE };
    },
    read: (subject) => {
        const key = merchantOf(subject);
        return `- **Merchant:** ${key ? inline(merchantName(key)) : "name not read"}`;
    },
    find: (subject) => {
        const { merchantEvent: stored } = subject;
        return [
            group(
                "Merchant",
                stored
                    ? [
                          `- **Find:** \`#${stored.id}\` ${inline(merchantName(stored.merchant))}`,
                          `- **Parser:** ${inline(stored.macro_type ?? "none")}`,
                          `- **When:** ${when(stored.received_at)}`,
                      ]
                    : null,
                "No merchant stored",
            ),
            sessionGroup(subject),
        ];
    },
    votes: (subject) => [buttonsGroup(subject)],
};

const normal: KindDescription = {
    verdict: () => ({ label: "✅ Normal biome (macro time only)", color: BLUE }),
    read: biomeLine,
    find: (subject) => [sessionGroup(subject)],
    votes: () => ["❌ Nothing to vote on"],
};

const nothing: KindDescription = {
    verdict: () => ({ label: "❌ Nothing read", color: RED }),
    read: biomeLine,
    find: (subject) => [sessionGroup(subject)],
    votes: () => ["❌ Nothing to vote on"],
};

export const KINDS: Record<ReportKind, KindDescription> = { biome, merchant, normal, nothing };

/** What was stored wins over what reads now only when nothing reads now. */
export function reportKind({ inspection, recorded, record, merchantEvent }: ReportSubject): ReportKind {
    if (inspection.event) return "biome";
    if (merchantEvent || inspection.checkpoint?.kind === "merchant") return "merchant";
    if (inspection.checkpoint) return "normal";
    return recorded || record.vote || record.network || record.casual ? "biome" : "nothing";
}
