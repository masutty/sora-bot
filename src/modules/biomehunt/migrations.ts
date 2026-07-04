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
    delete_inactive_after_s  INTEGER,                         /* NULL = disabled */

    counter_channel_id       VARCHAR(20),
    counter_message_id       VARCHAR(20),

    quota_eval_hour_utc       SMALLINT NOT NULL DEFAULT 0,     /* 0-23, F-mode reward eval hour */
    quota_last_evaluated_date DATE,                            /* last UTC date F-mode rewards ran */

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE bh_guilds ADD COLUMN IF NOT EXISTS quota_eval_hour_utc SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE bh_guilds ADD COLUMN IF NOT EXISTS quota_last_evaluated_date DATE;

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

CREATE TABLE IF NOT EXISTS bh_user_macro_channels (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL UNIQUE REFERENCES bh_users(id) ON DELETE CASCADE,
    channel_id VARCHAR(20) NOT NULL UNIQUE,
    webhook_id VARCHAR(20) NOT NULL,
    webhook_url TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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

`;
