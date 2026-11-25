import { UserFacingError } from "@/define";

export type StickyMode = "all" | "nobots";

export interface StickyRow {
    guild_id: string;
    channel_id: string;
    content: string;
    mode: StickyMode;
    delay_seconds: number;
    message_id: string | null;
    last_posted_at: Date | null;
    created_by: string;
    created_at: Date;
}

/** Carries a message that is safe to show the user as is. */
export class StickyError extends UserFacingError {}
