/**
 * BiomeHunt tunables - how the module *behaves* (timing, limits), never what the game *is*
 * (that lives in constants/). Changing a value here must never change a game rule.
 * Framework-wide UI defaults (view/confirm timeouts) belong in `@/config`, not here.
 */
export const settings = {
    workers: {
        statusTickMs: 30_000,
        roleTickMs: 2_000,
        counterTickMs: 5 * 60 * 1000,
        voteCloseTickMs: 5_000,
        networkPublishTickMs: 2_000,
        networkVoteCloseTickMs: 5_000,
        networkDailyTickMs: 60 * 60 * 1000,
    },
    votes: {
        /** How long a rare-biome community vote stays open before `closeDueVotes` resolves it. */
        windowMs: 60_000,
    },
    delayedForward: {
        /** The only delays `/bh-admin delayed-forward` offers - past 60s a delayed ping loses its point. */
        delayChoicesS: [5, 10, 15, 20, 25, 30, 45, 60],
    },
    network: {
        /** Macro time inside the window for a member to count as active - eligibility and (Phase 4) the activity alert. */
        activeMemberMinSeconds: 5 * 3600,
        activeMemberWindowDays: 7,
        minActiveMembers: 3,
        /** The server card's second, longer window (shown to the owner on a join request). */
        cardLongWindowDays: 30,
        /** Extra wait after the origin's own local post, so its members get first go at the private server. */
        homeAdvantageS: { GLITCHED: 10, DREAMSPACE: 10, SINGULARITY: 30, CYBERSPACE: 30 } as Readonly<Record<string, number>>,
        /** A pending Network Post this late (e.g. the bot was down) is dropped - the biome is likely over. */
        publishStaleMs: 2 * 60_000,
        /** Mirrors of one post sent at once - discord.js still queues them under the global rate limit. */
        publishConcurrency: 10,
        /** Same user + same biome from another server inside this window is Multi Macro; same private server is a duplicate. */
        dedupWindowMs: 2 * 60_000,
        /** How long a Network vote stays open, counted from the last Mirror sent. */
        voteWindowMs: 60_000,
        /** Servers that must reach a decided (non-tied) vote for the result to count - fewer is inconclusive. */
        minDecidedServers: 2,
        /** Daily activity checks in a row below the minimum before the owner is alerted. */
        lowActivityChecksToAlert: 2,
        /** UTC hour the daily Multi Macro digest DM goes out. */
        digestHourUtc: 12,
    },
    ui: {
        rerollIdleMs: 20_000,
        quotaReplyTimeoutMs: 60_000,
    },
    diagnostics: {
        /** Above this, `loadProfileData`'s DB round-trip is the likely bottleneck for a "profile felt slow" complaint - as opposed to Discord API slowness on the button clicks. */
        slowProfileLoadMs: 500,
    },
} as const;
