export const STICKY_SCHEMA = `
CREATE TABLE IF NOT EXISTS sm_stickies (
    channel_id     VARCHAR(20) PRIMARY KEY,
    guild_id       VARCHAR(20) NOT NULL,
    content        TEXT NOT NULL,
    mode           VARCHAR(10) NOT NULL DEFAULT 'all' CHECK (mode IN ('all', 'nobots')),
    delay_seconds  INT NOT NULL DEFAULT 300,
    message_id     VARCHAR(20),
    last_posted_at TIMESTAMPTZ,
    created_by     VARCHAR(20) NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sm_stickies_guild_idx ON sm_stickies (guild_id);

CREATE TABLE IF NOT EXISTS sm_guild_limits (
    guild_id     VARCHAR(20) PRIMARY KEY,
    max_stickies INT NOT NULL
);

CREATE TABLE IF NOT EXISTS sm_settings (
    id            SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    default_limit INT NOT NULL DEFAULT 5
);
`;
