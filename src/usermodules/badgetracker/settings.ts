/** Badge Tracker tunables - timing, limits and Roblox request behaviour. */
export const settings = {
    workers: {
        pollTickMs: 10_000,
    },
    interval: {
        defaultMinutes: 5,
        minMinutes: 1,
        maxMinutes: 60,
    },
    round: {
        /** Share of the interval over which a round's Roblox requests are spread. */
        spreadRatio: 0.8,
        minSpacingMs: 250,
    },
    gap: {
        maxMs: 3_600_000,
        intervalSlack: 1.5,
    },
    meta: {
        refreshMs: 86_400_000,
    },
    roblox: {
        timeoutMs: 10_000,
        userAgent: "sora-bot badge-tracker",
        iconBatch: 100,
        backoffBaseMs: 30_000,
        backoffMaxMs: 900_000,
    },
    discord: {
        sendConcurrency: 5,
    },
    limits: {
        perGuild: 25,
        global: Number(process.env.BADGE_TRACKER_MAX_BADGES ?? 200),
        descriptionMax: 300,
    },
    deletedAfterNotFound: 2,
    ui: {
        badgesPerPage: 5,
    },
} as const;
