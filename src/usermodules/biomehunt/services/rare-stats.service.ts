import { getAllBiomes, getBiomesByCategory } from "../constants/biomes.constants";
import { getGuildMacroSeconds, getGuildRareFinds, getGuildRareSessions } from "../repository/activity.repository";
import { type GuildRareFind, type RareSession, VoteStatus } from "../types";
import { badgeCounts, isFake } from "./rare-finds.service";

const DAY_MS = 86_400_000;

export type RarePeriod = "week" | "month" | "all";

/** How far back each period reaches - `all` has no start. */
const PERIOD_DAYS: Record<RarePeriod, number | null> = { week: 7, month: 30, all: null };

/** Everything the server-wide rare stats read, loaded once - switching section or period reads no database. */
export interface RareStatsData {
    guildId: string;
    /** Every rare find of the server, newest first - fake ones included. */
    finds: GuildRareFind[];
    /** The sessions that hold a rare find. */
    sessions: RareSession[];
    /** Every member's macro time per period, in seconds. */
    macroSeconds: Record<RarePeriod, number>;
    now: Date;
}

export async function loadRareStats(guildId: string, now = new Date()): Promise<RareStatsData> {
    const rare = getBiomesByCategory("rare");
    const [finds, sessions, macro] = await Promise.all([
        getGuildRareFinds(guildId, rare),
        getGuildRareSessions(guildId, rare),
        getGuildMacroSeconds(guildId),
    ]);
    return { guildId, finds, sessions, macroSeconds: { week: macro.week, month: macro.month, all: macro.all }, now };
}

/** The finds inside the period, newest first. */
export function findsInPeriod(data: RareStatsData, period: RarePeriod): GuildRareFind[] {
    const days = PERIOD_DAYS[period];
    if (days === null) return data.finds;
    const from = data.now.getTime() - days * DAY_MS;
    return data.finds.filter((f) => f.at.getTime() >= from);
}

/** True when the find's newest vote ruled it real (community or admin). */
export function isReal(f: GuildRareFind): boolean {
    return f.vote?.status === VoteStatus.COMMUNITY_REAL || f.vote?.status === VoteStatus.ADMIN_CONFIRMED;
}

const registryRank = (): ((biome: string) => number) => {
    const keys = getAllBiomes().map((b) => b.key);
    return (biome) => (keys.includes(biome) ? keys.indexOf(biome) : keys.length);
};

function groupBy<T>(items: T[], key: (item: T) => string | number): Map<string | number, T[]> {
    const groups = new Map<string | number, T[]>();
    for (const item of items) {
        const k = key(item);
        groups.set(k, [...(groups.get(k) ?? []), item]);
    }
    return groups;
}

// ─── Overview ───────────────────────────────────────────────────────────────

export interface RareOverview {
    /** Counted finds per biome, in registry order - `last` is the newest one. */
    biomes: Array<{ biome: string; count: number; last: Date }>;
    fake: number;
    top: Array<{ discordUserId: string; count: number; emojis: string }>;
    /** The newest finds, fake ones included. */
    latest: GuildRareFind[];
}

export const TOP_FINDERS = 5;
export const LATEST_FINDS = 5;

export function rareOverview(finds: GuildRareFind[]): RareOverview {
    const counted = finds.filter((f) => !isFake(f));
    const rank = registryRank();
    const biomes = [...groupBy(counted, (f) => f.biome)]
        .map(([biome, list]) => ({ biome: String(biome), count: list.length, last: list[0].at }))
        .sort((a, b) => rank(a.biome) - rank(b.biome));
    const top = [...groupBy(counted, (f) => f.discordUserId)]
        .map(([id, list]) => ({ discordUserId: String(id), count: list.length, emojis: badgeCounts(list) }))
        .sort((a, b) => b.count - a.count)
        .slice(0, TOP_FINDERS);
    return { biomes, fake: finds.length - counted.length, top, latest: finds.slice(0, LATEST_FINDS) };
}

// ─── Quality ────────────────────────────────────────────────────────────────

export interface RareQuality {
    /** Decided finds: real = Real/Confirmed, fake = Fake/Denied. */
    real: number;
    fake: number;
    /** Per biome with at least one decided find, in registry order. */
    biomes: Array<{ biome: string; real: number; fake: number }>;
    /** Finds per newest vote status. */
    votes: Record<VoteStatus, number>;
    /** Ballots per vote - `null` when there is no vote. */
    avgBallots: number | null;
    /** Finds that never had a vote (no forward set up). */
    noVote: number;
}

export function rareQuality(finds: GuildRareFind[]): RareQuality {
    const votes = Object.fromEntries(Object.values(VoteStatus).map((s) => [s, 0])) as Record<VoteStatus, number>;
    let ballots = 0;
    let voted = 0;
    for (const f of finds) {
        if (!f.vote) continue;
        votes[f.vote.status]++;
        ballots += f.vote.real + f.vote.fake;
        voted++;
    }
    const rank = registryRank();
    const biomes = [...groupBy(finds, (f) => f.biome)]
        .map(([biome, list]) => ({ biome: String(biome), real: list.filter(isReal).length, fake: list.filter(isFake).length }))
        .filter((b) => b.real + b.fake > 0)
        .sort((a, b) => rank(a.biome) - rank(b.biome));
    return {
        real: finds.filter(isReal).length,
        fake: finds.filter(isFake).length,
        biomes,
        votes,
        avgBallots: voted > 0 ? ballots / voted : null,
        noVote: finds.length - voted,
    };
}

// ─── Members ────────────────────────────────────────────────────────────────

export interface RareMember {
    discordUserId: string;
    real: number;
    fake: number;
    lastFake: Date | null;
    /** At least `FLAG_MIN_DECIDED` decided finds and under half of them real. */
    flagged: boolean;
}

export const FLAG_MIN_DECIDED = 3;

/** Every finder with a decided find: flagged ones first, then most fake finds first. */
export function rareMembers(finds: GuildRareFind[]): RareMember[] {
    return [...groupBy(finds, (f) => f.discordUserId)]
        .map(([id, list]) => {
            const real = list.filter(isReal).length;
            const fake = list.filter(isFake).length;
            return {
                discordUserId: String(id),
                real,
                fake,
                lastFake: list.find(isFake)?.at ?? null,
                flagged: real + fake >= FLAG_MIN_DECIDED && real / (real + fake) < 0.5,
            };
        })
        .filter((m) => m.real + m.fake > 0)
        .sort((a, b) => Number(b.flagged) - Number(a.flagged) || b.fake - a.fake || b.real - a.real);
}

// ─── Pace ───────────────────────────────────────────────────────────────────

export const PACE_DAYS = 14;
/** A biome needs this many finds before its usual gap means anything. */
export const WAITING_MIN_FINDS = 3;

export interface RarePace {
    /** Counted finds in the period. */
    count: number;
    macroSeconds: number;
    /** Macro time per counted find - `null` with no find or no macro time. */
    everySeconds: number | null;
    biomes: Array<{ biome: string; count: number; everySeconds: number }>;
    /** Counted finds per UTC day, oldest first - the last `PACE_DAYS` days, today included. */
    days: number[];
    /** UTC midnight of the oldest day. */
    firstDay: Date;
    thisWeek: number;
    lastWeek: number;
    /** Biomes with no find for longer than their usual gap - most overdue first. Reads all time. */
    waiting: Array<{ biome: string; sinceSeconds: number; usualSeconds: number }>;
}

export function rarePace(data: RareStatsData, period: RarePeriod): RarePace {
    const now = data.now.getTime();
    const allCounted = data.finds.filter((f) => !isFake(f));
    const counted = findsInPeriod(data, period).filter((f) => !isFake(f));
    const macroSeconds = data.macroSeconds[period];
    const rank = registryRank();

    const biomes = [...groupBy(counted, (f) => f.biome)]
        .map(([biome, list]) => ({ biome: String(biome), count: list.length, everySeconds: macroSeconds / list.length }))
        .sort((a, b) => rank(a.biome) - rank(b.biome));

    const today = Math.floor(now / DAY_MS) * DAY_MS;
    const firstDay = today - (PACE_DAYS - 1) * DAY_MS;
    const days = new Array<number>(PACE_DAYS).fill(0);
    for (const f of allCounted) {
        const i = Math.floor((f.at.getTime() - firstDay) / DAY_MS);
        if (i >= 0 && i < PACE_DAYS) days[i]++;
    }
    const since = (ms: number) => allCounted.filter((f) => f.at.getTime() >= now - ms).length;

    const waiting = [...groupBy(allCounted, (f) => f.biome)]
        .filter(([, list]) => list.length >= WAITING_MIN_FINDS)
        .map(([biome, list]) => ({
            biome: String(biome),
            sinceSeconds: (now - list[0].at.getTime()) / 1000,
            usualSeconds: (list[0].at.getTime() - list[list.length - 1].at.getTime()) / 1000 / (list.length - 1),
        }))
        .filter((w) => w.sinceSeconds > w.usualSeconds)
        .sort((a, b) => b.sinceSeconds / b.usualSeconds - a.sinceSeconds / a.usualSeconds);

    return {
        count: counted.length,
        macroSeconds,
        everySeconds: counted.length > 0 && macroSeconds > 0 ? macroSeconds / counted.length : null,
        biomes: macroSeconds > 0 ? biomes : [],
        days,
        firstDay: new Date(firstDay),
        thisWeek: since(7 * DAY_MS),
        lastWeek: since(14 * DAY_MS) - since(7 * DAY_MS),
        waiting,
    };
}

// ─── Records ────────────────────────────────────────────────────────────────

export interface RareRecords {
    /** Only from 2 finds up. */
    mostInSession: { discordUserId: string; sessionId: number; count: number; emojis: string } | null;
    /** Only from 2 finds up. `day` is UTC midnight. */
    bestDay: { day: Date; count: number } | null;
    /** The find closest to its session's start. */
    fastest: { discordUserId: string; biome: string; seconds: number } | null;
    /** The shortest gap between two finds of one biome by one member. */
    backToBack: { discordUserId: string; biome: string; seconds: number } | null;
    /** The longest gap between two finds of one biome. */
    longestWait: { biome: string; seconds: number } | null;
    first: GuildRareFind | null;
}

/** Each consecutive pair of a time-ordered list, as the gap in seconds plus the later item. */
function gaps<T extends { at: Date }>(oldestFirst: T[]): Array<{ seconds: number; item: T }> {
    return oldestFirst.slice(1).map((item, i) => ({ seconds: (item.at.getTime() - oldestFirst[i].at.getTime()) / 1000, item }));
}

export function rareRecords(finds: GuildRareFind[], sessions: RareSession[]): RareRecords {
    const counted = finds.filter((f) => !isFake(f)).reverse();
    const sessionsByUser = groupBy(sessions, (s) => s.userId);
    const sessionOf = (f: GuildRareFind) => sessionsByUser.get(f.userId)?.find((s) => f.at >= s.startedAt && f.at <= s.endedAt) ?? null;

    let mostInSession: RareRecords["mostInSession"] = null;
    let fastest: RareRecords["fastest"] = null;
    const bySession = new Map<number, GuildRareFind[]>();
    for (const f of counted) {
        const s = sessionOf(f);
        if (!s) continue;
        bySession.set(s.id, [...(bySession.get(s.id) ?? []), f]);
        const seconds = (f.at.getTime() - s.startedAt.getTime()) / 1000;
        if (!fastest || seconds < fastest.seconds) fastest = { discordUserId: f.discordUserId, biome: f.biome, seconds };
    }
    for (const [sessionId, list] of bySession) {
        if (list.length >= 2 && list.length > (mostInSession?.count ?? 0))
            mostInSession = { discordUserId: list[0].discordUserId, sessionId, count: list.length, emojis: badgeCounts(list) };
    }

    let bestDay: RareRecords["bestDay"] = null;
    for (const [day, list] of groupBy(counted, (f) => Math.floor(f.at.getTime() / DAY_MS))) {
        if (list.length >= 2 && list.length > (bestDay?.count ?? 0)) bestDay = { day: new Date(Number(day) * DAY_MS), count: list.length };
    }

    let backToBack: RareRecords["backToBack"] = null;
    for (const list of groupBy(counted, (f) => `${f.userId}:${f.biome}`).values()) {
        for (const g of gaps(list)) {
            if (!backToBack || g.seconds < backToBack.seconds)
                backToBack = { discordUserId: g.item.discordUserId, biome: g.item.biome, seconds: g.seconds };
        }
    }

    let longestWait: RareRecords["longestWait"] = null;
    for (const [biome, list] of groupBy(counted, (f) => f.biome)) {
        for (const g of gaps(list)) {
            if (!longestWait || g.seconds > longestWait.seconds) longestWait = { biome: String(biome), seconds: g.seconds };
        }
    }

    return { mostInSession, bestDay, fastest, backToBack, longestWait, first: counted[0] ?? null };
}
