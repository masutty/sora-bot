import type { FlagName } from "../types";

/**
 * What a flag does, for the flags menu. A flag either has one `description`, or - when the two
 * states need explaining - an `on` and an `off` line (the menu shows both, the confirm only the one
 * that will apply).
 */
export type FlagDescription =
    | { description: string; on?: undefined; off?: undefined }
    | { on: string; off: string; description?: undefined };

export type FlagDefinition = FlagDescription & { default: boolean };

/** SINGLE SOURCE OF TRUTH for every guild feature flag - the flags menu reads name/description/default straight from here. */
export const FLAG_DEFINITIONS: Record<FlagName, FlagDefinition> = {
    REPORT_SESSION_ON_END: {
        description: "Posts a session summary (duration + biome breakdown) in the member's macro channel when their session ends.",
        default: false,
    },
    PING_ON_QUOTA_MET: {
        description: "Posts in the member's macro channel the moment they newly meet a quota role's target.",
        default: false,
    },
    AUTO_DELETE_ENABLED: {
        description: "Auto-deletes inactive members' macro channels. The hours after going inactive are set in `/admin settings`.",
        default: false,
    },
    CLEAR_PROFILE_ON_AUTODELETE: {
        on: "auto-delete fully wipes the member's data.",
        off: "only the macro channel goes; history, badges and quota status stay, and they get the 'Deleted?!' badge.",
        default: false,
    },
    EXPERIMENT_WEBHOOK_FLOWERS: {
        on: "macro webhooks get a random Flower name and avatar on setup, rerollable by an admin or paid self-service.",
        off: "webhooks keep their plain name; no Flower is assigned or shown.",
        default: false,
    },
    EXPERIMENT_BIOME_ECONOMY: {
        on: "finding biomes earns Seeds and XP (shown on the profile), and Seeds can be spent (e.g. a paid Flower reroll).",
        off: "biome badges still work, but no Seeds/XP are earned or shown.",
        default: false,
    },
};

export const ALL_FLAGS: FlagName[] = Object.keys(FLAG_DEFINITIONS) as FlagName[];

/** Flags the Flags menu lists. The two auto-delete flags live in Settings -> Auto-delete instead. */
export const MENU_FLAGS: FlagName[] = ALL_FLAGS.filter((flag) => flag !== "AUTO_DELETE_ENABLED" && flag !== "CLEAR_PROFILE_ON_AUTODELETE");
