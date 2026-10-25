import { getMemberLog } from "../repository/member-log.repository";
import { getNetworkPostsByFinder } from "../repository/network-posts.repository";
import { type MemberLogRow, type NetworkPostRow, type RareFind, VoteStatus } from "../types";

const DAY_MS = 86_400_000;

/** Fewer decided rare finds than this and there is no level yet. */
export const QUALITY_MIN_DECIDED = 3;
const RECENT_DAYS = 30;

export type QualityLevel = "none" | "trusted" | "watch" | "untrusted";

/** Real, fake, tied and still-voting rare finds - one place (this server or the Network). */
export interface FindTally {
    real: number;
    fake: number;
    tied: number;
    voting: number;
}

/** One History row: a bad vote result (with what to review) or a logged admin action. */
export type QualityEvent =
    | { type: "local"; at: Date; find: RareFind }
    | { type: "network"; at: Date; post: NetworkPostRow }
    | { type: "log"; at: Date; log: MemberLogRow };

export interface MemberQuality {
    level: QualityLevel;
    local: FindTally;
    network: FindTally;
    /** Count of each logged admin action kind. */
    actions: { sessionsDeleted: number; badgesTaken: number; findsRemoved: number };
    /** Newest first. */
    history: QualityEvent[];
}

const emptyTally = (): FindTally => ({ real: 0, fake: 0, tied: 0, voting: 0 });

/** True when a local find's newest vote ruled it fake (community or admin). */
const isLocalFake = (f: RareFind) => f.vote?.status === VoteStatus.COMMUNITY_FAKE || f.vote?.status === VoteStatus.ADMIN_DENIED;

const postAt = (p: NetworkPostRow) => p.published_at ?? p.created_at;

function localTally(finds: RareFind[]): FindTally {
    const t = emptyTally();
    for (const f of finds) {
        switch (f.vote?.status) {
            case VoteStatus.COMMUNITY_REAL:
            case VoteStatus.ADMIN_CONFIRMED:
                t.real++;
                break;
            case VoteStatus.COMMUNITY_FAKE:
            case VoteStatus.ADMIN_DENIED:
                t.fake++;
                break;
            case VoteStatus.TIE:
                t.tied++;
                break;
            case VoteStatus.OPEN:
                t.voting++;
                break;
        }
    }
    return t;
}

function networkTally(posts: NetworkPostRow[]): FindTally {
    const t = emptyTally();
    for (const p of posts) {
        if (p.vote_status === "real") t.real++;
        else if (p.vote_status === "fake") t.fake++;
        else if (p.vote_status === "inconclusive") t.tied++;
        else t.voting++;
    }
    return t;
}

/**
 * The level from decided rare finds only (local and Network together): under 3 decided = none;
 * over 25% fake or 3+ fakes in 30 days = untrusted; 10%+ fake or any fake in 30 days = watch;
 * otherwise trusted. Admin actions show on the tab but don't move the level.
 */
export function qualityLevel(decided: number, fake: number, recentFakes: number): QualityLevel {
    if (decided < QUALITY_MIN_DECIDED) return "none";
    const rate = fake / decided;
    if (rate > 0.25 || recentFakes >= 3) return "untrusted";
    if (rate >= 0.1 || recentFakes >= 1) return "watch";
    return "trusted";
}

/** Builds the Quality tab from the member's rare finds here, their Network posts and the admin log. */
export function buildMemberQuality(finds: RareFind[], posts: NetworkPostRow[], log: MemberLogRow[], now = new Date()): MemberQuality {
    const local = localTally(finds);
    const network = networkTally(posts);
    const since = now.getTime() - RECENT_DAYS * DAY_MS;
    const localFakes = finds.filter(isLocalFake);
    const networkFakes = posts.filter((p) => p.vote_status === "fake");
    const recentFakes =
        localFakes.filter((f) => f.at.getTime() >= since).length + networkFakes.filter((p) => postAt(p).getTime() >= since).length;
    const level = qualityLevel(local.real + local.fake + network.real + network.fake, local.fake + network.fake, recentFakes);

    const history: QualityEvent[] = [
        ...localFakes.map((find) => ({ type: "local" as const, at: find.at, find })),
        ...networkFakes.map((post) => ({ type: "network" as const, at: postAt(post), post })),
        ...log.map((row) => ({ type: "log" as const, at: row.created_at, log: row })),
    ].sort((a, b) => b.at.getTime() - a.at.getTime());

    const actions = { sessionsDeleted: 0, badgesTaken: 0, findsRemoved: 0 };
    for (const row of log) {
        if (row.kind === "sessions_deleted") actions.sessionsDeleted += row.detail.count;
        else if (row.kind === "badge_taken") actions.badgesTaken++;
        else if (row.kind === "finds_changed" && row.detail.to < row.detail.from) actions.findsRemoved += row.detail.from - row.detail.to;
    }
    return { level, local, network, actions, history };
}

/** Loads and builds the Quality tab for a member whose rare finds are already loaded. */
export async function loadMemberQuality(guildId: string, discordUserId: string, finds: RareFind[]): Promise<MemberQuality> {
    const [posts, log] = await Promise.all([getNetworkPostsByFinder(discordUserId), getMemberLog(guildId, discordUserId)]);
    return buildMemberQuality(finds, posts, log);
}
