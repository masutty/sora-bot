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
    },
    votes: {
        /** How long a rare-biome community vote stays open before `closeDueVotes` resolves it. */
        windowMs: 60_000,
    },
    delayedForward: {
        /** The only delays `/bh-admin delayed-forward` offers - past 60s a delayed ping loses its point. */
        delayChoicesS: [5, 10, 15, 20, 25, 30, 45, 60],
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
