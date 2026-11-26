/** Moderation tunables. */
export const settings = {
    defaultReason: "No reason given",
    defaultWarnExpiryDays: 30,
    warnExpiryDaysRange: { min: 1, max: 365 },
    /** Discord's 28 day timeout cap, minus a minute so the end date never lands past it. */
    maxMuteSeconds: 28 * 86400 - 60,
    maxLongSeconds: 365 * 86400,
    maxReason: 1000,
    maxWeight: 100,
    maxAppealLine: 300,
    softbanDeleteSeconds: 86400,
    pageSize: 8,
    maxThresholds: 25,
    warnColor: 0xf0b232,
    punishColor: 0xda373c,
    endColor: 0x23a55a,
    endedColor: 0x80848e,
    accentColor: 0x5865f2,
} as const;
