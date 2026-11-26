export const MODERATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS mod_cases (
    id              CHAR(7) PRIMARY KEY,
    guild_id        VARCHAR(20) NOT NULL,
    kind            VARCHAR(10) NOT NULL CHECK (kind IN ('warn', 'mute', 'kick', 'ban', 'softban', 'temprole')),
    user_id         VARCHAR(20) NOT NULL,
    moderator_id    VARCHAR(20),
    reason          TEXT NOT NULL,
    weight          INT NOT NULL DEFAULT 1,
    role_id         VARCHAR(20),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ,
    ended_at        TIMESTAMPTZ,
    end_reason      VARCHAR(10) CHECK (end_reason IN ('expired', 'revoked', 'replaced')),
    ended_by        VARCHAR(20),
    end_note        TEXT,
    triggered_by    CHAR(7),
    threshold_level INT,
    dm_delivered    BOOLEAN
);

ALTER TABLE mod_cases ADD COLUMN IF NOT EXISTS dm_error TEXT;

CREATE INDEX IF NOT EXISTS mod_cases_user_idx ON mod_cases (guild_id, user_id);
CREATE INDEX IF NOT EXISTS mod_cases_due_idx ON mod_cases (expires_at) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS mod_cases_moderator_idx ON mod_cases (guild_id, moderator_id, created_at);

CREATE TABLE IF NOT EXISTS mod_case_events (
    id      BIGSERIAL PRIMARY KEY,
    case_id CHAR(7) NOT NULL REFERENCES mod_cases (id),
    kind    VARCHAR(20) NOT NULL CHECK (kind IN ('created', 'revoked', 'expired', 'replaced', 'reason_changed', 'auto_undone')),
    by_id   VARCHAR(20),
    data    JSONB NOT NULL DEFAULT '{}'::jsonb,
    at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS mod_case_events_case_idx ON mod_case_events (case_id, id);

CREATE TABLE IF NOT EXISTS mod_settings (
    guild_id         VARCHAR(20) PRIMARY KEY,
    case_channel_id  VARCHAR(20),
    warn_expiry_days INT NOT NULL DEFAULT 30,
    auto_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
    auto_undo        BOOLEAN NOT NULL DEFAULT TRUE,
    appeal_line      TEXT
);

ALTER TABLE mod_settings ADD COLUMN IF NOT EXISTS moderator_role_id VARCHAR(20);

CREATE TABLE IF NOT EXISTS mod_thresholds (
    guild_id   VARCHAR(20) NOT NULL,
    warns      INT NOT NULL,
    action     VARCHAR(10) CHECK (action IN ('mute', 'kick', 'ban')),
    duration_s INT,
    PRIMARY KEY (guild_id, warns)
);
`;
