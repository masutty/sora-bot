import { ContainerBuilder, SeparatorSpacingSize } from "discord.js";
import type { RenderKit } from "@/core/view/view";
import { paginationRow } from "@/define";
import { formatCodeblock, formatTime, unix } from "@/utils/format";
import { formatBiomeName, getBiomeAnsiColor } from "../constants/biomes.constants";
import { biomeTitle, formatFindLine } from "../services/rare-finds.service";
import {
    findsInPeriod,
    PACE_DAYS,
    type RarePeriod,
    type RareStatsData,
    rareMembers,
    rareOverview,
    rarePace,
    rareQuality,
    rareRecords,
} from "../services/rare-stats.service";
import { VoteStatus } from "../types";

export type RareSection = "overview" | "quality" | "members" | "pace" | "records";

const SECTIONS: Array<{ key: RareSection; label: string; title: string }> = [
    { key: "overview", label: "Overview", title: "Rare Finds" },
    { key: "quality", label: "Quality", title: "Rare Quality" },
    { key: "members", label: "Members", title: "Rare Finders" },
    { key: "pace", label: "Pace", title: "Rare Pace" },
    { key: "records", label: "Records", title: "Rare Records" },
];

const PERIODS: Array<{ key: RarePeriod; label: string; empty: string }> = [
    { key: "week", label: "Last 7 days", empty: "No rare finds in the last 7 days." },
    { key: "month", label: "Last 30 days", empty: "No rare finds in the last 30 days." },
    { key: "all", label: "All time", empty: "No rare finds yet." },
];

export const RARE_MEMBERS_PER_PAGE = 10;

const ANSI_RESET = "\u001b[0m";
const ANSI_YELLOW = "\u001b[33m";
const BAR_WIDTH = 10;
const LABEL_WIDTH = 11;
const SPARKS = "▁▂▃▄▅▆▇█";

/** Seconds to the nearest hour (or minute, under an hour) - `27h` reads better than `1d 3h 12m 4s`. */
function roughTime(seconds: number): string {
    const unit = seconds >= 3600 ? 3600 : 60;
    return formatTime(Math.max(unit, Math.round(seconds / unit) * unit));
}

const quote = (lines: string[]) => lines.map((l) => `> ${l}`).join("\n");

/** One section's text blocks - a divider goes between them. */
type Blocks = string[];

function overviewBlocks(data: RareStatsData, period: RarePeriod): Blocks {
    const o = rareOverview(findsInPeriod(data, period));
    const blocks: Blocks = [];
    if (o.biomes.length > 0) {
        const lines = o.biomes.map((b) => `${biomeTitle(b.biome)} · \`${b.count}\` · last <t:${unix(b.last)}:R>`);
        blocks.push(`${quote(lines)}${o.fake > 0 ? `\n-# ${o.fake} fake ${o.fake === 1 ? "find" : "finds"} not counted` : ""}`);
    }
    if (o.top.length > 0) {
        const lines = o.top.map((t, i) => [`**${i + 1}.** <@${t.discordUserId}>`, `\`${t.count}\``, t.emojis].filter(Boolean).join(" · "));
        blocks.push(`**Top finders**\n${quote(lines)}`);
    }
    const latest = o.latest.flatMap((f) => formatFindLine(data.guildId, f, { finderId: f.discordUserId, time: "R" }).split("\n"));
    blocks.push(`**Latest**\n${quote(latest)}`);
    return blocks;
}

/** `████████░░  86%  12/14` after the biome's name in its ANSI style. */
function qualityBar(biome: string, real: number, fake: number, countWidth: number): string {
    const name = formatBiomeName(biome);
    const label = name.length > LABEL_WIDTH ? `${name.slice(0, LABEL_WIDTH - 1)}…` : name.padEnd(LABEL_WIDTH);
    const ratio = real / (real + fake);
    const filled = Math.round(ratio * BAR_WIDTH);
    const bar = "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
    const count = `${real}/${real + fake}`.padStart(countWidth);
    return `${getBiomeAnsiColor(biome)}${label}${ANSI_RESET}  ${bar}  ${`${Math.round(ratio * 100)}%`.padStart(4)}  ${count}`;
}

function qualityBlocks(data: RareStatsData, period: RarePeriod): Blocks {
    const q = rareQuality(findsInPeriod(data, period));
    const v = q.votes;
    const blocks: Blocks = [];
    if (q.real + q.fake > 0) {
        const countWidth = Math.max(...q.biomes.map((b) => `${b.real}/${b.real + b.fake}`.length));
        const bars = q.biomes.map((b) => qualityBar(b.biome, b.real, b.fake, countWidth)).join("\n");
        const pct = Math.round((q.real / (q.real + q.fake)) * 100);
        blocks.push(`**${pct}% real** · ${q.real} real · ${q.fake} fake\n${formatCodeblock(bars, "ansi")}`);
    } else {
        blocks.push("No decided votes yet.");
    }
    const votes = [
        `✅ Real \`${v[VoteStatus.COMMUNITY_REAL]}\` · ❌ Fake \`${v[VoteStatus.COMMUNITY_FAKE]}\` by the community`,
        `✅ Confirmed \`${v[VoteStatus.ADMIN_CONFIRMED]}\` · ❌ Denied \`${v[VoteStatus.ADMIN_DENIED]}\` by admins`,
        `⚖️ Tied \`${v[VoteStatus.TIE]}\` · No votes \`${v[VoteStatus.NO_VOTES]}\` · ⏳ Voting \`${v[VoteStatus.OPEN]}\``,
        ...(q.avgBallots !== null ? [`Average \`${q.avgBallots.toFixed(1)}\` ballots per vote`] : []),
        ...(q.noVote > 0 ? [`No forward \`${q.noVote}\``] : []),
    ];
    blocks.push(`**Votes**\n${quote(votes)}`);
    return blocks;
}

export function rareMembersPageCount(data: RareStatsData, period: RarePeriod): number {
    return Math.max(1, Math.ceil(rareMembers(findsInPeriod(data, period)).length / RARE_MEMBERS_PER_PAGE));
}

function membersBlocks(data: RareStatsData, period: RarePeriod, page: number): Blocks {
    const members = rareMembers(findsInPeriod(data, period));
    if (members.length === 0) return ["No decided votes yet."];
    const lines = members.slice(page * RARE_MEMBERS_PER_PAGE, (page + 1) * RARE_MEMBERS_PER_PAGE).map((m) => {
        const pct = Math.round((m.real / (m.real + m.fake)) * 100);
        const lastFake = m.flagged && m.lastFake ? ` · last fake <t:${unix(m.lastFake)}:R>` : "";
        return `${m.flagged ? "⚠️ " : ""}<@${m.discordUserId}> · \`${m.real}/${m.real + m.fake}\` real · ${pct}%${lastFake}`;
    });
    return [quote(lines)];
}

/** One bar per day, `▁` for none - scaled to the busiest day. */
function sparkline(days: number[]): string {
    const max = Math.max(...days);
    return days.map((n) => (n === 0 || max === 0 ? SPARKS[0] : SPARKS[Math.max(1, Math.round((n / max) * (SPARKS.length - 1)))])).join("");
}

const shortDate = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function paceBlocks(data: RareStatsData, period: RarePeriod): Blocks {
    const p = rarePace(data, period);
    const blocks: Blocks = [];
    if (p.everySeconds !== null) {
        const lines = p.biomes.map((b) => `${biomeTitle(b.biome)} · every \`${roughTime(b.everySeconds)}\``);
        blocks.push(
            `**1 rare every ${roughTime(p.everySeconds)}** of macro time · \`${roughTime(p.macroSeconds)}\` macroed\n${quote(lines)}`,
        );
    }
    const lastDay = new Date(p.firstDay.getTime() + (PACE_DAYS - 1) * 86_400_000);
    const from = shortDate(p.firstDay);
    const to = shortDate(lastDay);
    const chart = `${ANSI_YELLOW}${sparkline(p.days)}${ANSI_RESET}\n${from}${to.padStart(PACE_DAYS - from.length)}`;
    blocks.push(
        `**Last ${PACE_DAYS} days** · this week \`${p.thisWeek}\` · last week \`${p.lastWeek}\`\n${formatCodeblock(chart, "ansi")}`,
    );
    if (p.waiting.length > 0) {
        const lines = p.waiting.map(
            (w) => `${biomeTitle(w.biome)} · none for \`${roughTime(w.sinceSeconds)}\` · usually every \`${roughTime(w.usualSeconds)}\``,
        );
        blocks.push(`**Waiting for**\n${quote(lines)}`);
    }
    return blocks;
}

function recordsBlocks(data: RareStatsData, period: RarePeriod): Blocks {
    const r = rareRecords(findsInPeriod(data, period), data.sessions);
    const plain = (biome: string) => biomeTitle(biome).replace(/\*\*/g, "");
    const lines = [
        r.mostInSession &&
            [
                `🏆 **Most in one session** · \`${r.mostInSession.count}\` · <@${r.mostInSession.discordUserId}> · session \`#${r.mostInSession.sessionId}\``,
                r.mostInSession.emojis,
            ]
                .filter(Boolean)
                .join(" · "),
        r.bestDay && `📅 **Best day** · \`${r.bestDay.count}\` · <t:${unix(r.bestDay.day) + 43_200}:D>`,
        r.fastest &&
            `⚡ **Fastest** · <@${r.fastest.discordUserId}> · ${plain(r.fastest.biome)} \`${roughTime(r.fastest.seconds)}\` into a session`,
        r.backToBack &&
            `🔁 **Back to back** · <@${r.backToBack.discordUserId}> · ${plain(r.backToBack.biome)} twice in \`${roughTime(r.backToBack.seconds)}\``,
        r.longestWait && `⏳ **Longest wait** · ${plain(r.longestWait.biome)} · \`${roughTime(r.longestWait.seconds)}\` between finds`,
        r.first && `🥇 **First rare** · <@${r.first.discordUserId}> · ${plain(r.first.biome)} · <t:${unix(r.first.at)}:D>`,
    ].filter((l): l is string => Boolean(l));
    return [lines.length > 0 ? quote(lines) : "No records yet."];
}

/** The Rares tab's container: the section's title, then its blocks split by dividers. */
export function buildRareSection(data: RareStatsData, section: RareSection, period: RarePeriod, page: number): ContainerBuilder {
    const container = new ContainerBuilder().setAccentColor(0x5865f2);
    const title = SECTIONS.find((s) => s.key === section)?.title ?? "Rare Finds";
    container.addTextDisplayComponents((td) => td.setContent(`## 💎 ${title}`));
    const empty = findsInPeriod(data, period).length === 0;
    const blocks = empty
        ? [PERIODS.find((p) => p.key === period)?.empty ?? ""]
        : {
              overview: () => overviewBlocks(data, period),
              quality: () => qualityBlocks(data, period),
              members: () => membersBlocks(data, period, page),
              pace: () => paceBlocks(data, period),
              records: () => recordsBlocks(data, period),
          }[section]();
    for (const block of blocks) {
        container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
        container.addTextDisplayComponents((td) => td.setContent(block));
    }
    return container;
}

/** The section and period selects - plus the page row on Members when it has more than one page. */
export function rareControlRows(kit: RenderKit, data: RareStatsData, section: RareSection, period: RarePeriod, page: number) {
    const pages = section === "members" ? rareMembersPageCount(data, period) : 1;
    return [
        ...(pages > 1 ? [paginationRow(kit, page, pages)] : []),
        kit.row(
            kit.stringSelect("rare-section", (s) =>
                s.addOptions(SECTIONS.map((x) => ({ label: x.label, value: x.key, default: x.key === section }))),
            ),
        ),
        kit.row(
            kit.stringSelect("rare-period", (s) =>
                s.addOptions(PERIODS.map((x) => ({ label: x.label, value: x.key, default: x.key === period }))),
            ),
        ),
    ];
}
