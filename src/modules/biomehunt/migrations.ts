export const BIOMEHUNT_SCHEMA = `

/* ───────────────────────────────────────────── */
/* Per-guild configuration                      */
/* ───────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS bh_guilds (
    guild_id                 VARCHAR(20) PRIMARY KEY,

    session_gap_threshold_s  INTEGER NOT NULL DEFAULT 1200,   /* 20min */
    idle_threshold_s         INTEGER NOT NULL DEFAULT 1800,   /* 30min */
    inactive_threshold_s     INTEGER NOT NULL DEFAULT 86400,  /* 24h */

    auto_create_categories   BOOLEAN NOT NULL DEFAULT FALSE,
    delete_inactive_after_s  INTEGER NOT NULL DEFAULT 86400,  /* hours-after-inactive threshold; whether it's acted on is gated by the AUTO_DELETE_ENABLED flag */

    counter_channel_id       VARCHAR(20),
    counter_message_id       VARCHAR(20),

    quota_eval_hour_utc       SMALLINT NOT NULL DEFAULT 0,     /* 0-23, F-mode reward eval hour */
    quota_last_evaluated_date DATE,                            /* last UTC date F-mode rewards ran */

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE bh_guilds ADD COLUMN IF NOT EXISTS quota_eval_hour_utc SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE bh_guilds ADD COLUMN IF NOT EXISTS quota_last_evaluated_date DATE;

/* Forwarding is now fully implicit (a biome forwards iff it has a configured channel) - no separate on/off switch. */
ALTER TABLE bh_guilds DROP COLUMN IF EXISTS forwarding_enabled;

/* General guild-wide quota was replaced entirely by per-role quota rewards (bh_quota_roles). */
ALTER TABLE bh_guilds DROP COLUMN IF EXISTS quota_window_hours;
ALTER TABLE bh_guilds DROP COLUMN IF EXISTS quota_target_seconds;

CREATE TABLE IF NOT EXISTS bh_guild_categories (
    id SERIAL PRIMARY KEY,
    guild_id VARCHAR(20) NOT NULL REFERENCES bh_guilds(guild_id) ON DELETE CASCADE,
    discord_category_id VARCHAR(20) NOT NULL,
    is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE(guild_id, discord_category_id)
);

CREATE TABLE IF NOT EXISTS bh_guild_roles (
    guild_id VARCHAR(20) PRIMARY KEY REFERENCES bh_guilds(guild_id) ON DELETE CASCADE,
    active_role_id   VARCHAR(20),
    idle_role_id     VARCHAR(20),
    inactive_role_id VARCHAR(20)
);

/* ───────────────────────────────────────────── */
/* Users                                        */
/* ───────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS bh_users (
    id SERIAL PRIMARY KEY,
    guild_id VARCHAR(20) NOT NULL REFERENCES bh_guilds(guild_id) ON DELETE CASCADE,
    discord_user_id VARCHAR(20) NOT NULL,
    current_status VARCHAR(10) NOT NULL DEFAULT 'inactive',
    last_activity_at TIMESTAMPTZ,
    paused_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(guild_id, discord_user_id)
);

CREATE INDEX IF NOT EXISTS bh_users_status ON bh_users(guild_id, current_status);
CREATE INDEX IF NOT EXISTS bh_users_last_activity ON bh_users(last_activity_at) WHERE last_activity_at IS NOT NULL;

ALTER TABLE bh_users ADD COLUMN IF NOT EXISTS seeds INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bh_users ADD COLUMN IF NOT EXISTS xp INTEGER NOT NULL DEFAULT 0;

/* Flower lives on the user, not the macro channel - it must survive soft-delete/reset-channel
   (which only drop the bh_user_macro_channels row), so a user keeps the same Flower across
   channel resets and only a real reroll (/bh reroll, /bh-owner reroll-flower) changes it. */
ALTER TABLE bh_users ADD COLUMN IF NOT EXISTS flower VARCHAR(32);

CREATE TABLE IF NOT EXISTS bh_user_macro_channels (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL UNIQUE REFERENCES bh_users(id) ON DELETE CASCADE,
    channel_id VARCHAR(20) NOT NULL UNIQUE,
    webhook_id VARCHAR(20) NOT NULL,
    webhook_url TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

/* One-time carry-over from the old per-channel Flower column into bh_users.flower above - the
   ADD/UPDATE/DROP trio here is safe to keep running (idempotent): on a fresh install the ADD
   creates an empty column with no rows to migrate, on an upgraded install it migrates existing
   data once, then both converge on the same DROP. */
ALTER TABLE bh_user_macro_channels ADD COLUMN IF NOT EXISTS flower VARCHAR(32);
UPDATE bh_users u SET flower = mc.flower
FROM bh_user_macro_channels mc
WHERE mc.user_id = u.id AND mc.flower IS NOT NULL AND u.flower IS NULL;
ALTER TABLE bh_user_macro_channels DROP COLUMN IF EXISTS flower;

/* ───────────────────────────────────────────── */
/* Activity                                     */
/* ───────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS bh_activity_events (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES bh_users(id) ON DELETE CASCADE,
    discord_message_id VARCHAR(20) NOT NULL UNIQUE,
    biome VARCHAR(50),
    macro_type VARCHAR(100),
    event_type VARCHAR(10),                 /* 'started' | 'ended' | NULL (unknown) */
    event_timestamp TIMESTAMPTZ,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE bh_activity_events ADD COLUMN IF NOT EXISTS event_type VARCHAR(10);

CREATE INDEX IF NOT EXISTS bh_activity_events_user ON bh_activity_events(user_id, received_at DESC);

CREATE TABLE IF NOT EXISTS bh_activity_sessions (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES bh_users(id) ON DELETE CASCADE,
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ NOT NULL,
    duration_seconds INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS bh_activity_sessions_user ON bh_activity_sessions(user_id, started_at DESC);

/* ───────────────────────────────────────────── */
/* Biome rewards (Seeds/XP/badge ledger)        */
/* ───────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS bh_biome_rewards (
    event_id       INTEGER PRIMARY KEY REFERENCES bh_activity_events(id) ON DELETE CASCADE,
    user_id        INTEGER NOT NULL REFERENCES bh_users(id) ON DELETE CASCADE,
    biome          VARCHAR(64) NOT NULL,
    seeds_awarded  INTEGER NOT NULL,
    xp_awarded     INTEGER NOT NULL,
    badge_awarded  VARCHAR(32),
    awarded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bh_biome_rewards_user_badge ON bh_biome_rewards(user_id, badge_awarded) WHERE badge_awarded IS NOT NULL;

/* ───────────────────────────────────────────── */
/* Quota rewards                                */
/* ───────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS bh_quota_roles (
    id SERIAL PRIMARY KEY,
    guild_id VARCHAR(20) NOT NULL REFERENCES bh_guilds(guild_id) ON DELETE CASCADE,
    role_id VARCHAR(20) NOT NULL,
    mode VARCHAR(2) NOT NULL CHECK (mode IN ('F', 'RW')),
    quota_target_seconds INTEGER NOT NULL,
    quota_window_hours INTEGER NOT NULL,
    access_duration_days INTEGER,   /* NULL iff mode = 'RW'; required iff mode = 'F' */
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(guild_id, role_id)
);

CREATE TABLE IF NOT EXISTS bh_user_quota_roles (
    user_id INTEGER NOT NULL REFERENCES bh_users(id) ON DELETE CASCADE,
    quota_role_id INTEGER NOT NULL REFERENCES bh_quota_roles(id) ON DELETE CASCADE,
    granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,   /* NULL for RW mode (no fixed expiry; revoked reactively) */
    PRIMARY KEY (user_id, quota_role_id)
);

/* ───────────────────────────────────────────── */
/* Special biome badges                         */
/* ───────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS bh_guild_badge_roles (
    guild_id VARCHAR(20) NOT NULL REFERENCES bh_guilds(guild_id) ON DELETE CASCADE,
    badge    VARCHAR(20) NOT NULL,   /* 'GLITCHED' | 'CYBERSPACE' | 'DREAMSPACE' - same value as bh_activity_events.biome */
    role_id  VARCHAR(20) NOT NULL,
    PRIMARY KEY (guild_id, badge)
);

CREATE TABLE IF NOT EXISTS bh_user_badges (
    user_id    INTEGER NOT NULL REFERENCES bh_users(id) ON DELETE CASCADE,
    badge      VARCHAR(20) NOT NULL,
    awarded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, badge)
);

/* ───────────────────────────────────────────── */
/* Biome forwards                               */
/* ───────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS bh_biome_forwards (
    guild_id   VARCHAR(20) NOT NULL REFERENCES bh_guilds(guild_id) ON DELETE CASCADE,
    biome      VARCHAR(20) NOT NULL,
    channel_id VARCHAR(20) NOT NULL,
    role_id    VARCHAR(20),
    PRIMARY KEY (guild_id, biome)
);

/*
 * Same shape as bh_biome_forwards plus a delay - fully independent of it (a biome can have either,
 * both, or neither). The pending sends themselves live only in memory (a setTimeout per find), so a
 * restart drops them; with delays capped at 60s that's accepted.
 */
CREATE TABLE IF NOT EXISTS bh_biome_delayed_forwards (
    guild_id   VARCHAR(20) NOT NULL REFERENCES bh_guilds(guild_id) ON DELETE CASCADE,
    biome      VARCHAR(20) NOT NULL,
    channel_id VARCHAR(20) NOT NULL,
    role_id    VARCHAR(20),
    delay_s    SMALLINT NOT NULL,
    PRIMARY KEY (guild_id, biome)
);

/* ───────────────────────────────────────────── */
/* Rare-biome community votes                   */
/* ───────────────────────────────────────────── */

/*
 * id is a short random code (like a trace ref), never sequential - avoids a vote id being
 * guessable. channel_id/message_id and closes_at let closeDueVotes (a worker) re-fetch and
 * re-edit the forward message on its own, including for a vote left open by a restart - no
 * in-memory state survives across a process restart, unlike the old admin-only vote check.
 */
CREATE TABLE IF NOT EXISTS bh_biome_votes (
    id             TEXT PRIMARY KEY,
    guild_id       VARCHAR(20) NOT NULL REFERENCES bh_guilds(guild_id) ON DELETE CASCADE,
    event_id       INTEGER NOT NULL REFERENCES bh_activity_events(id) ON DELETE CASCADE,
    finder_user_id INTEGER NOT NULL REFERENCES bh_users(id) ON DELETE CASCADE,
    channel_id     VARCHAR(20) NOT NULL,
    message_id     VARCHAR(20) NOT NULL,
    biome          VARCHAR(64) NOT NULL,
    status         VARCHAR(20) NOT NULL DEFAULT 'open',   /* open | no_votes | tie | community_real | community_fake | admin_confirmed | admin_denied */
    decided_by     VARCHAR(20),                            /* admin's discord id - set only for admin_confirmed/admin_denied */
    closes_at      TIMESTAMPTZ NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    decided_at     TIMESTAMPTZ
);

/*
 * The forward message's own render inputs, captured at open time - role_id/server_link/
 * jump_link/find_count are never re-derived from bh_biome_forwards/parsed macro text/a live
 * recount at close/admin-decide time (a forward config can change mid-vote, the macro text isn't
 * stored anywhere else, and a recount could differ from what the original message showed). The
 * message is always rebuilt from THIS row, not from its own currently-rendered components.
 */
ALTER TABLE bh_biome_votes ADD COLUMN IF NOT EXISTS role_id VARCHAR(20);
ALTER TABLE bh_biome_votes ADD COLUMN IF NOT EXISTS server_link TEXT;
ALTER TABLE bh_biome_votes ADD COLUMN IF NOT EXISTS jump_link TEXT;
ALTER TABLE bh_biome_votes ADD COLUMN IF NOT EXISTS find_count INTEGER;
/* Same idea for the redesigned forward card's finder / "Server find #N" / "Last one" - NULL on votes opened before it. */
ALTER TABLE bh_biome_votes ADD COLUMN IF NOT EXISTS finder_discord_id VARCHAR(20);
ALTER TABLE bh_biome_votes ADD COLUMN IF NOT EXISTS server_find_count INTEGER;
ALTER TABLE bh_biome_votes ADD COLUMN IF NOT EXISTS last_seen_in_server_at TIMESTAMPTZ;

/*
 * event_id used to be NOT NULL with ON DELETE CASCADE - an admin's deny deletes the underlying
 * event, which used to cascade away the vote AND its ballots too: /bh-admin review <id> would
 * then say "No vote with that id.", and the rejected-find stats derivable from the ballot rows
 * were gone. Now nullable with ON DELETE SET NULL: denying still deletes the event, but the vote
 * and its ballots survive with event_id = NULL - applyOutcome (biome-vote.service.ts) skips any
 * grant/revert once it's null (there's no event left to credit/debit), and review shows the vote
 * normally, noting the event is gone. Re-run safely on an existing dev table: DROP CONSTRAINT IF
 * EXISTS + ADD CONSTRAINT (Postgres has no ADD CONSTRAINT IF NOT EXISTS) always converges on the
 * same SET NULL constraint, whether this is a fresh table or one that still has the old CASCADE.
 */
ALTER TABLE bh_biome_votes ALTER COLUMN event_id DROP NOT NULL;
ALTER TABLE bh_biome_votes DROP CONSTRAINT IF EXISTS bh_biome_votes_event_id_fkey;
ALTER TABLE bh_biome_votes
    ADD CONSTRAINT bh_biome_votes_event_id_fkey
    FOREIGN KEY (event_id) REFERENCES bh_activity_events(id) ON DELETE SET NULL;

/* Scanned every 5s by the vote-close worker - only ever matches rows still 'open'. */
CREATE INDEX IF NOT EXISTS bh_biome_votes_open ON bh_biome_votes(status, closes_at) WHERE status = 'open';

/*
 * One row per (vote, voter) - the primary key IS the "one vote per user, no changing" rule (a
 * second INSERT for the same pair is rejected outright by ON CONFLICT DO NOTHING in the
 * repository, never overwritten). user_id is the voter's raw Discord id, not bh_users.id -
 * a voter doesn't need a BiomeHunt profile to vote.
 */
CREATE TABLE IF NOT EXISTS bh_biome_vote_ballots (
    vote_id    TEXT NOT NULL REFERENCES bh_biome_votes(id) ON DELETE CASCADE,
    user_id    VARCHAR(20) NOT NULL,
    choice     VARCHAR(10) NOT NULL,   /* real | fake */
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (vote_id, user_id)
);

/* ───────────────────────────────────────────── */
/* Role queue                                   */
/* ───────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS bh_role_jobs (
    id BIGSERIAL PRIMARY KEY,
    guild_id VARCHAR(20) NOT NULL REFERENCES bh_guilds(guild_id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES bh_users(id) ON DELETE CASCADE,
    role_id VARCHAR(20) NOT NULL,
    action VARCHAR(10) NOT NULL,
    retry_count INTEGER NOT NULL DEFAULT 0,
    execute_after TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS bh_role_jobs_pending ON bh_role_jobs(execute_after) WHERE processed = FALSE;

/* ───────────────────────────────────────────── */
/* Feature flags                                */
/* ───────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS bh_guild_flags (
    guild_id   VARCHAR(20) NOT NULL REFERENCES bh_guilds(guild_id) ON DELETE CASCADE,
    flag_name  VARCHAR(40) NOT NULL,
    enabled    BOOLEAN NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (guild_id, flag_name)
);

/*
 * delete_inactive_after_s used to be nullable, with NULL meaning "auto-delete disabled".
 * That's now controlled by the AUTO_DELETE_ENABLED flag instead, so the column becomes a
 * plain always-set duration. Guilds that had a real (non-null) value get the flag turned on
 * here, to preserve their existing behavior across the migration.
 */
INSERT INTO bh_guild_flags (guild_id, flag_name, enabled)
SELECT guild_id, 'AUTO_DELETE_ENABLED', TRUE FROM bh_guilds WHERE delete_inactive_after_s IS NOT NULL
ON CONFLICT (guild_id, flag_name) DO NOTHING;

UPDATE bh_guilds SET delete_inactive_after_s = 86400 WHERE delete_inactive_after_s IS NULL;
ALTER TABLE bh_guilds ALTER COLUMN delete_inactive_after_s SET DEFAULT 86400;
ALTER TABLE bh_guilds ALTER COLUMN delete_inactive_after_s SET NOT NULL;

/*
 * The backfill above turned AUTO_DELETE_ENABLED on for every existing guild to preserve legacy
 * behavior - but auto-delete acting on stale last_activity_at timestamps (e.g. right after
 * restoring an older database backup) deleted several users' macro channels for real. The flag's
 * own default is already false (see FLAG_DEFINITIONS) - reset every guild back to that actual
 * default here, unconditionally. Admins who want it back on: "!bh-admin flag set flag:AUTO_DELETE_ENABLED enabled:true".
 */
UPDATE bh_guild_flags SET enabled = FALSE WHERE flag_name = 'AUTO_DELETE_ENABLED';

`;
