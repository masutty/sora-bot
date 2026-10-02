import { formatBiomeName, getBiomesByCategory } from "../constants/biomes.constants";
import { getGuildActiveSecondsBetween } from "../repository/activity.repository";
import { getDelayedForwardConfigs } from "../repository/delayed-forwards.repository";
import { getForwardConfigs } from "../repository/forwards.repository";
import { getNetworkGuild } from "../repository/network.repository";
import { settings } from "../settings";

/** Every biome the Network carries - a Member Server must forward all of them locally (live or delayed). */
export const NETWORK_BIOMES: readonly string[] = getBiomesByCategory("rare");

const DAY_MS = 86_400_000;

/** Everything the checklist looks at, already loaded - `evaluateEligibility` is pure. */
export interface EligibilityFacts {
    forwardedBiomes: ReadonlySet<string>;
    /** Every live and delayed local forward channel - the Network channel must be none of them. */
    localForwardChannelIds: ReadonlySet<string>;
    networkChannelId: string | null;
    staffChannelId: string | null;
    staffRoleId: string | null;
    activeMembers: number;
}

export type EligibilityGap =
    | { kind: "forwards"; missing: string[] }
    | { kind: "network_channel" }
    | { kind: "network_channel_conflict" }
    | { kind: "staff" }
    | { kind: "activity"; activeMembers: number };

export function evaluateEligibility(facts: EligibilityFacts): EligibilityGap[] {
    const gaps: EligibilityGap[] = [];
    const missing = NETWORK_BIOMES.filter((b) => !facts.forwardedBiomes.has(b));
    if (missing.length > 0) gaps.push({ kind: "forwards", missing });
    if (!facts.networkChannelId) gaps.push({ kind: "network_channel" });
    else if (facts.localForwardChannelIds.has(facts.networkChannelId)) gaps.push({ kind: "network_channel_conflict" });
    if (!facts.staffChannelId || !facts.staffRoleId) gaps.push({ kind: "staff" });
    if (facts.activeMembers < settings.network.minActiveMembers) gaps.push({ kind: "activity", activeMembers: facts.activeMembers });
    return gaps;
}

/** The gaps the Network config flow can fix - `/bh-network join` checks the OTHER ones before opening it. */
export function isConfigGap(gap: EligibilityGap): boolean {
    return gap.kind === "network_channel" || gap.kind === "network_channel_conflict" || gap.kind === "staff";
}

export function describeGap(gap: EligibilityGap): string {
    switch (gap.kind) {
        case "forwards":
            return `A local forward (live or delayed) for: ${gap.missing.map(formatBiomeName).join(", ")}`;
        case "network_channel":
            return "A Network channel";
        case "network_channel_conflict":
            return "A Network channel that is not one of your local forward channels";
        case "staff":
            return "A staff channel and a staff role";
        case "activity": {
            const { minActiveMembers, activeMemberMinSeconds, activeMemberWindowDays } = settings.network;
            return `At least ${minActiveMembers} active members (${activeMemberMinSeconds / 3600}h+ of macro in the last ${activeMemberWindowDays} days) - you have ${gap.activeMembers}`;
        }
    }
}

/** Members with at least `activeMemberMinSeconds` of macro time - exactly the minimum counts. */
export function countActiveMembers(rows: ReadonlyArray<{ activeSeconds: number }>): number {
    return rows.filter((r) => r.activeSeconds >= settings.network.activeMemberMinSeconds).length;
}

/** The server card a bot owner sees on a join request (and admins on `/bh-network status`). */
export interface ServerCard {
    activeMembers: number;
    macroHours7d: number;
    macroHours30d: number;
}

function totalHours(rows: ReadonlyArray<{ activeSeconds: number }>): number {
    return Math.round(rows.reduce((sum, r) => sum + r.activeSeconds, 0) / 360) / 10;
}

export function buildServerCard(
    rows7d: ReadonlyArray<{ activeSeconds: number }>,
    rows30d: ReadonlyArray<{ activeSeconds: number }>,
): ServerCard {
    return { activeMembers: countActiveMembers(rows7d), macroHours7d: totalHours(rows7d), macroHours30d: totalHours(rows30d) };
}

/** Injected so tests never touch the DB - `defaultEligibilityDeps` wires the real repository. */
export interface EligibilityDeps {
    getNetworkGuild: typeof getNetworkGuild;
    getForwardConfigs: typeof getForwardConfigs;
    getDelayedForwardConfigs: typeof getDelayedForwardConfigs;
    getGuildActiveSecondsBetween: typeof getGuildActiveSecondsBetween;
}

export function defaultEligibilityDeps(): EligibilityDeps {
    return { getNetworkGuild, getForwardConfigs, getDelayedForwardConfigs, getGuildActiveSecondsBetween };
}

export interface EligibilityReport {
    facts: EligibilityFacts;
    gaps: EligibilityGap[];
    card: ServerCard;
}

export async function loadEligibility(
    guildId: string,
    now: Date = new Date(),
    deps: EligibilityDeps = defaultEligibilityDeps(),
): Promise<EligibilityReport> {
    const shortStart = new Date(now.getTime() - settings.network.activeMemberWindowDays * DAY_MS);
    const longStart = new Date(now.getTime() - settings.network.cardLongWindowDays * DAY_MS);
    const [row, live, delayed, rows7d, rows30d] = await Promise.all([
        deps.getNetworkGuild(guildId),
        deps.getForwardConfigs(guildId),
        deps.getDelayedForwardConfigs(guildId),
        deps.getGuildActiveSecondsBetween(guildId, shortStart, now),
        deps.getGuildActiveSecondsBetween(guildId, longStart, now),
    ]);
    const forwards = [...live, ...delayed];
    const facts: EligibilityFacts = {
        forwardedBiomes: new Set(forwards.map((f) => f.biome)),
        localForwardChannelIds: new Set(forwards.map((f) => f.channel_id)),
        networkChannelId: row?.network_channel_id ?? null,
        staffChannelId: row?.staff_channel_id ?? null,
        staffRoleId: row?.staff_role_id ?? null,
        activeMembers: countActiveMembers(rows7d),
    };
    return { facts, gaps: evaluateEligibility(facts), card: buildServerCard(rows7d, rows30d) };
}
