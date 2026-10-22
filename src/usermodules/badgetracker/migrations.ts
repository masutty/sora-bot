export const BADGE_TRACKER_SCHEMA = `
CREATE TABLE IF NOT EXISTS bt_badges (
    badge_id          VARCHAR(20) PRIMARY KEY,
    name              TEXT NOT NULL,
    description       TEXT NOT NULL DEFAULT '',
    icon_url          TEXT,
    awarded_count     BIGINT,
    last_checked_at   TIMESTAMPTZ,
    meta_refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    not_found_streak  INT NOT NULL DEFAULT 0,
    deleted           BOOLEAN NOT NULL DEFAULT FALSE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bt_guilds (
    guild_id   VARCHAR(20) PRIMARY KEY,
    channel_id VARCHAR(20)
);

CREATE TABLE IF NOT EXISTS bt_subscriptions (
    guild_id           VARCHAR(20) NOT NULL,
    badge_id           VARCHAR(20) NOT NULL REFERENCES bt_badges(badge_id) ON DELETE CASCADE,
    ping_role_id       VARCHAR(20),
    custom_description TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (guild_id, badge_id)
);

ALTER TABLE bt_subscriptions ADD COLUMN IF NOT EXISTS accent_color INTEGER;

CREATE INDEX IF NOT EXISTS bt_subscriptions_badge_idx ON bt_subscriptions (badge_id);

CREATE TABLE IF NOT EXISTS bt_settings (
    id               SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    interval_minutes INT NOT NULL DEFAULT 5,
    last_round_at    TIMESTAMPTZ
);
`;
