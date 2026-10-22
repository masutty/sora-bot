// Shared tuning values for the owner-only `/bot log live` feed.
// `BUFFER_SIZE` and `ENTRY_MAX_CHARS` live in `@/utils/log-buffer` next to the buffer itself.

/** The feed's own logger namespace - always hidden from the render, kept in the buffer. */
export const LIVE_FEED_NAMESPACE = "bot_internals.live-feed";

/** How often the feed message refreshes. */
export const TICK_MS = 5_000;
/** Lifetime of a freshly started feed. */
export const INITIAL_MS = 60_000;
/** Time added each time the owner extends the feed. */
export const EXTEND_MS = 30_000;
/** Hard cap on a feed's total lifetime (Discord interaction tokens expire after 15 min). */
export const CEILING_MS = 14 * 60_000;
/** Remaining time at which the feed switches to its warning look. */
export const WARNING_MS = 15_000;

/** Max log lines rendered in one feed message. */
export const MAX_LINES = 30;
/** Max characters of log content rendered in one feed message. */
export const MAX_CHARS = 3_800;

export const ACCENT_NORMAL = 0x5865f2;
export const ACCENT_WARNING = 0xfee75c;
