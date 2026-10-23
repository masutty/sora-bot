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
ALTER TABLE bh_guilds ADD COLUMN IF NOT EXISTS log_channel_id VARCHAR(20);

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
   channel resets and only a real reroll (/bh reroll, /owner reroll-flower) changes it. */
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
ALTER TABLE bh_biome_votes ADD COLUMN IF NOT EXISTS fake_reported_at TIMESTAMPTZ;

/*
 * event_id used to be NOT NULL with ON DELETE CASCADE - an admin's deny deletes the underlying
 * event, which used to cascade away the vote AND its ballots too: /admin review-voting <id> would
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
 * a voter doesn't need a hunter profile to vote.
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
 * delete_inactive_after_s used to be nullable, with NULL meaning "auto-delete disabled". That's
 * now the AUTO_DELETE_ENABLED flag, so the column is a plain always-set duration.
 *
 * NEVER write bh_guild_flags from this schema. This whole string re-runs every time any part of it
 * changes, so a flag write here repeats on every such deploy. Two one-time steps used to live here:
 * a backfill that turned AUTO_DELETE_ENABLED ON for every guild with an old non-null value, and a
 * reset that turned it OFF for every guild. Auto-delete once deleted real users' macro channels.
 * Both are long done and were removed; flags change only through an admin action
 * (/admin flags or ez-setup). migrations.test.ts enforces this.
 */
UPDATE bh_guilds SET delete_inactive_after_s = 86400 WHERE delete_inactive_after_s IS NULL;
ALTER TABLE bh_guilds ALTER COLUMN delete_inactive_after_s SET DEFAULT 86400;
ALTER TABLE bh_guilds ALTER COLUMN delete_inactive_after_s SET NOT NULL;

/* ───────────────────────────────────────────── */
/* The Network                                  */
/* ───────────────────────────────────────────── */

/*
 * One row per guild that ever touched the Network. status: none | pending | member. The row
 * outlives a leave, removal or rejection (status back to 'none') so a rejoin starts with the old
 * config pre-filled. forced = put in by the bot owner without the eligibility checklist.
 */
CREATE TABLE IF NOT EXISTS bh_network_guilds (
    guild_id           VARCHAR(20) PRIMARY KEY REFERENCES bh_guilds(guild_id) ON DELETE CASCADE,
    status             VARCHAR(10) NOT NULL DEFAULT 'none',
    forced             BOOLEAN NOT NULL DEFAULT FALSE,
    network_channel_id VARCHAR(20),
    staff_channel_id   VARCHAR(20),
    staff_role_id      VARCHAR(20),
    announce_role_id   VARCHAR(20),
    invite_url         TEXT,
    requested_at       TIMESTAMPTZ,
    approved_at        TIMESTAMPTZ,
    decided_by         VARCHAR(20),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS bh_network_guilds_status ON bh_network_guilds(status);

/* The role a Member Server pings for each Network biome on its Mirrors - no row = no ping. */
CREATE TABLE IF NOT EXISTS bh_network_pings (
    guild_id VARCHAR(20) NOT NULL REFERENCES bh_network_guilds(guild_id) ON DELETE CASCADE,
    biome    VARCHAR(20) NOT NULL,
    role_id  VARCHAR(20) NOT NULL,
    PRIMARY KEY (guild_id, biome)
);

/* Network Ban - bot owner only, Network-wide. No FK: a banned guild may have no hunting data at all. */
CREATE TABLE IF NOT EXISTS bh_network_bans (
    kind       VARCHAR(5) NOT NULL,     /* guild | user */
    target_id  VARCHAR(20) NOT NULL,
    banned_by  VARCHAR(20) NOT NULL,
    reason     TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (kind, target_id)
);

/* Network Exclusion - a Member Server admin stops one member's finds from being published. */
CREATE TABLE IF NOT EXISTS bh_network_exclusions (
    guild_id        VARCHAR(20) NOT NULL REFERENCES bh_guilds(guild_id) ON DELETE CASCADE,
    discord_user_id VARCHAR(20) NOT NULL,
    excluded_by     VARCHAR(20) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (guild_id, discord_user_id)
);

/*
 * One row per Network Post. status: pending | publishing | published | discarded. origin_* and
 * invite_url are a render snapshot taken at find time - every Mirror (and its single edit at vote
 * close) is built from this row, never re-derived. No FK on origin_guild_id: the post outlives the
 * guild's hunting data (the alert history points at it).
 */
CREATE TABLE IF NOT EXISTS bh_network_posts (
    id                TEXT PRIMARY KEY,
    origin_guild_id   VARCHAR(20) NOT NULL,
    origin_name       TEXT NOT NULL,
    origin_icon_url   TEXT,
    invite_url        TEXT,
    event_id          INTEGER REFERENCES bh_activity_events(id) ON DELETE SET NULL,
    finder_discord_id VARCHAR(20) NOT NULL,
    biome             VARCHAR(20) NOT NULL,
    server_link       TEXT NOT NULL,
    server_code       VARCHAR(128) NOT NULL,
    status            VARCHAR(12) NOT NULL DEFAULT 'pending',
    publish_at        TIMESTAMPTZ NOT NULL,
    published_at      TIMESTAMPTZ,
    vote_status       VARCHAR(12) NOT NULL DEFAULT 'open',   /* open | real | fake | inconclusive */
    vote_closes_at    TIMESTAMPTZ,
    vote_closed_by    VARCHAR(20),                           /* bot owner's id when closed by hand */
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS bh_network_posts_pending ON bh_network_posts(publish_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS bh_network_posts_open_votes ON bh_network_posts(vote_closes_at) WHERE status = 'published' AND vote_status = 'open';
CREATE INDEX IF NOT EXISTS bh_network_posts_recent ON bh_network_posts(biome, created_at DESC);

/* The message a Network Post created in one Member Server - needed for the single edit at vote close. */
CREATE TABLE IF NOT EXISTS bh_network_mirrors (
    post_id    TEXT NOT NULL REFERENCES bh_network_posts(id) ON DELETE CASCADE,
    guild_id   VARCHAR(20) NOT NULL,
    channel_id VARCHAR(20) NOT NULL,
    message_id VARCHAR(20) NOT NULL,
    PRIMARY KEY (post_id, guild_id)
);

/* One ballot per person per Network Post (the PK) - guild_id is the server it was clicked in (shown in lookups, not weighed). */
CREATE TABLE IF NOT EXISTS bh_network_ballots (
    post_id         TEXT NOT NULL REFERENCES bh_network_posts(id) ON DELETE CASCADE,
    discord_user_id VARCHAR(20) NOT NULL,
    guild_id        VARCHAR(20) NOT NULL,
    choice          VARCHAR(10) NOT NULL,   /* real | fake */
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (post_id, discord_user_id)
);

/* Alerts for the bot owner (fake_verdict | multi_macro | low_activity) - the history /network-admin lookup reads. */
CREATE TABLE IF NOT EXISTS bh_network_alerts (
    id              BIGSERIAL PRIMARY KEY,
    kind            VARCHAR(20) NOT NULL,
    guild_id        VARCHAR(20),
    discord_user_id VARCHAR(20),
    post_id         TEXT,
    details         TEXT NOT NULL,
    notified        BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS bh_network_alerts_guild ON bh_network_alerts(guild_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bh_network_alerts_user ON bh_network_alerts(discord_user_id, created_at DESC);

/* A "/owner simulate-biome network_relays:true" test post - shown as a test, no ping, no vote. */
ALTER TABLE bh_network_posts ADD COLUMN IF NOT EXISTS simulated BOOLEAN NOT NULL DEFAULT FALSE;
/* The only Member Servers a test post goes to (the ids given in network_relays) - NULL on real posts, which go to every member. */
ALTER TABLE bh_network_posts ADD COLUMN IF NOT EXISTS relay_guild_ids TEXT[];

/* The ping role each Mirror was sent with - its vote-close edit keeps showing it (an edit never pings). */
ALTER TABLE bh_network_mirrors ADD COLUMN IF NOT EXISTS role_id VARCHAR(20);

/* The daily activity check's streak (Phase 4): consecutive daily checks below the minimum. */
ALTER TABLE bh_network_guilds ADD COLUMN IF NOT EXISTS low_activity_checks SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE bh_network_guilds ADD COLUMN IF NOT EXISTS last_activity_check DATE;

/* ───────────────────────────────────────────── */
/* Biome registry                               */
/* ───────────────────────────────────────────── */

/* Every recognized biome - managed by the bot owner with /owner biome, seeded on boot from
   DEFAULT_BIOMES (constants/biomes.constants.ts). Never deleted: a retired biome is disabled, so
   old finds keep their label/color/category. */
CREATE TABLE IF NOT EXISTS bh_biomes (
    biome       VARCHAR(40) PRIMARY KEY,                /* canonical space-less uppercase key */
    label       VARCHAR(60) NOT NULL,
    category    VARCHAR(10) NOT NULL,                   /* biome | weather | rare | event */
    color       INTEGER NOT NULL,                       /* 0xRRGGBB */
    flavor_text TEXT,
    icon_url    TEXT,
    ansi_color  VARCHAR(20),                            /* raw ANSI escape prefix */
    enabled     BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order  INTEGER NOT NULL DEFAULT 0,             /* picker/display order */
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

/* How long a timed biome lasts - while it runs, its finder can't go idle (see activity.service.ts). NULL = not timed. */
ALTER TABLE bh_biomes ADD COLUMN IF NOT EXISTS duration_s INTEGER;

/* Badges (see badges.constants.ts): a biome with has_badge gives a profile badge, keyed by the biome. */
ALTER TABLE bh_biomes ADD COLUMN IF NOT EXISTS has_badge BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE bh_biomes ADD COLUMN IF NOT EXISTS badge_emoji VARCHAR(64);
/* The 3 badges that used to be hard-coded - only while badge_emoji is still unset, so an owner's later change sticks. */
UPDATE bh_biomes SET has_badge = TRUE, badge_emoji = '🔥' WHERE biome = 'GLITCHED' AND badge_emoji IS NULL;
UPDATE bh_biomes SET has_badge = TRUE, badge_emoji = '🌐' WHERE biome = 'CYBERSPACE' AND badge_emoji IS NULL;
UPDATE bh_biomes SET has_badge = TRUE, badge_emoji = '🌸' WHERE biome = 'DREAMSPACE' AND badge_emoji IS NULL;
/* A badge is a biome key now, which can be up to 40 characters - widened once (skipped when already done, so no table lock on every boot). */
DO $$
BEGIN
    IF (SELECT character_maximum_length FROM information_schema.columns WHERE table_name = 'bh_user_badges' AND column_name = 'badge') < 40 THEN
        ALTER TABLE bh_user_badges ALTER COLUMN badge TYPE VARCHAR(40);
        ALTER TABLE bh_guild_badge_roles ALTER COLUMN badge TYPE VARCHAR(40);
        ALTER TABLE bh_biome_rewards ALTER COLUMN badge_awarded TYPE VARCHAR(40);
    END IF;
END $$;

/* The user's activity grace from the most recently started timed biome - they count as active until activity_grace_until. */
ALTER TABLE bh_users ADD COLUMN IF NOT EXISTS activity_grace_until TIMESTAMPTZ;
ALTER TABLE bh_users ADD COLUMN IF NOT EXISTS activity_grace_biome VARCHAR(40);

/* Daily rewards (mode F) are always a 24h window - fixes rows stored with another window. */
UPDATE bh_quota_roles SET quota_window_hours = 24 WHERE mode = 'F' AND quota_window_hours <> 24;

/* A voter can switch their ballot once - changed marks that they did, so a second switch is refused. */
ALTER TABLE bh_biome_vote_ballots ADD COLUMN IF NOT EXISTS changed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE bh_network_ballots ADD COLUMN IF NOT EXISTS changed BOOLEAN NOT NULL DEFAULT FALSE;

/* Bot-wide settings an owner changes at runtime (vote durations) - one row per key, read through a cache. */
CREATE TABLE IF NOT EXISTS bh_bot_settings (
    key        VARCHAR(60) PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

/* The bot owner who decided a Network vote with a click - NULL when the ballots decided it. */
ALTER TABLE bh_network_posts ADD COLUMN IF NOT EXISTS vote_decided_by VARCHAR(20);

/* One-time data fixes: a name here is never run again, even though the schema text re-runs on every change. */
CREATE TABLE IF NOT EXISTS bh_data_migrations (
    name       VARCHAR(80) PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

/* Delayed forwards are only for rare biomes - drops the non-rare ones set before that rule, once.
   Skipped while bh_biomes is still empty (seeded after the schema runs): every row would look non-rare. */
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM bh_data_migrations WHERE name = 'delayed-forwards-rare-only')
       AND EXISTS (SELECT 1 FROM bh_biomes) THEN
        DELETE FROM bh_biome_delayed_forwards d
         WHERE NOT EXISTS (SELECT 1 FROM bh_biomes b WHERE b.biome = d.biome AND b.category = 'rare');
        INSERT INTO bh_data_migrations (name) VALUES ('delayed-forwards-rare-only');
    END IF;
END $$;

`;
