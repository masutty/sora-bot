import type { FlagName } from "../types";

/** SINGLE SOURCE OF TRUTH for every guild feature flag - `flag list` reads name/description/default straight from here. */
export const FLAG_DEFINITIONS: Record<FlagName, { label: string; description: string; default: boolean }> = {
    REPORT_SESSION_ON_END: {
        label: "Report Session On End",
        description: "Post a session summary (duration + biome breakdown) to a user's macro channel when their session ends.",
        default: false,
    },
    PING_ON_QUOTA_MET: {
        label: "Ping On Quota Met",
        description: "Post a notification to a user's macro channel the moment they freshly meet a quota role's requirement.",
        default: false,
    },
    CLEAR_PROFILE_ON_AUTODELETE: {
        label: "Clear Profile On Autodelete",
        description: "ON: inactivity auto-delete fully wipes the user's data. OFF (default): auto-delete only removes their macro channel, keeping history/badges/quota status, and awards the 'Deleted?!' badge.",
        default: false,
    },
    AUTO_DELETE_ENABLED: {
        label: "Auto Delete Enabled",
        description: "Whether inactive users' macro channels get auto-deleted at all. The number of hours after going inactive is set separately via `activity delete`.",
        default: false,
    },
    EXPERIMENT_WEBHOOK_FLOWERS: {
        label: "Experiment: Webhook Flowers",
        description: "ON: macro webhooks get a random Flower name/avatar on setup, and can be rerolled (admin or paid self-service). OFF (default): webhooks keep their plain name, no Flower is ever assigned or shown.",
        default: false,
    },
    EXPERIMENT_BIOME_ECONOMY: {
        label: "Experiment: Biome Economy",
        description: "ON: finding biomes earns Seeds and XP (shown on the profile), and Seeds can be spent (e.g. a paid Flower reroll). OFF (default): biome badges still work normally, but no Seeds/XP are earned or shown.",
        default: false,
    },
};

export const ALL_FLAGS: FlagName[] = Object.keys(FLAG_DEFINITIONS) as FlagName[];
