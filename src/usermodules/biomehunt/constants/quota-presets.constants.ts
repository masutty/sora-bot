import type { QuotaRoleMode } from "../types";

export interface QuotaPreset {
    key: "daily-grinder" | "weekly";
    label: string;
    /** Shown under the label in the preset select. */
    description: string;
    mode: QuotaRoleMode;
    targetS: number;
    /** Daily rewards always count 24h. */
    windowH: number;
    /** Days the role lasts - daily rewards only. */
    days: number | null;
}

/** Ready-made quotas offered by "Add quota". */
export const QUOTA_PRESETS: QuotaPreset[] = [
    {
        key: "daily-grinder",
        label: "Daily grinder",
        description: "Daily reward · 5h in a day → 1 day",
        mode: "F",
        targetS: 5 * 3600,
        windowH: 24,
        days: 1,
    },
    {
        key: "weekly",
        label: "Weekly",
        description: "Live role · 20h in the last 7 days",
        mode: "RW",
        targetS: 20 * 3600,
        windowH: 168,
        days: null,
    },
];
