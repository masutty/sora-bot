export const BIOME_HUNTER_SCHEMA = `

/* ─────────────────────────────────────────── */
/* Guild configuration                         */
/* ─────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS bh_guild_config (
    guild_id        VARCHAR(20) PRIMARY KEY,

    green_role_id   VARCHAR(20),
    yellow_role_id  VARCHAR(20),
    red_role_id     VARCHAR(20),

    -- seconds of inactivity before GREEN → YELLOW
    yellow_threshold_s  INTEGER NOT NULL DEFAULT 300,
    -- seconds of inactivity before YELLOW → RED  
    red_threshold_s     INTEGER NOT NULL DEFAULT 900,

    -- channel where the live counter message lives
    counter_channel_id  VARCHAR(20),
    counter_message_id  VARCHAR(20),

    -- categories where macro channels are created
    macro_category_ids  VARCHAR(20)[] NOT NULL DEFAULT '{}',

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


/* ─────────────────────────────────────────── */
/* User profiles                               */
/* ─────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS bh_user_profiles (
    user_id             VARCHAR(20) NOT NULL,
    guild_id            VARCHAR(20) NOT NULL,

    dedicated_channel_id VARCHAR(20) UNIQUE,
    webhook_id          VARCHAR(20),
    webhook_url         TEXT,   -- store encrypted or omit if unnecessary

    -- current activity state: 'green' | 'yellow' | 'red'
    current_state       VARCHAR(10) NOT NULL DEFAULT 'red',

    last_activity       TIMESTAMPTZ,
    total_messages      BIGINT NOT NULL DEFAULT 0,
    total_active_s      BIGINT NOT NULL DEFAULT 0,

    -- biome counters stored as JSONB: { "Ancient": 42, "Glitch": 7, ... }
    -- avoids N writes per message; updated in batch flush
    biome_counts        JSONB NOT NULL DEFAULT '{}',

    registered_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (user_id, guild_id)
);

-- Fast lookup: is this channel a macro channel? (hot path, every message)
CREATE UNIQUE INDEX IF NOT EXISTS bh_user_profiles_channel
    ON bh_user_profiles(dedicated_channel_id);

-- For StateEngine: find users whose status should change
CREATE INDEX IF NOT EXISTS bh_user_profiles_last_activity
    ON bh_user_profiles(guild_id, last_activity)
    WHERE last_activity IS NOT NULL;

CREATE INDEX IF NOT EXISTS bh_user_profiles_state
    ON bh_user_profiles(guild_id, current_state);
`;
