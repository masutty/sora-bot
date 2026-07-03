export const ROLLING_SIM_SCHEMA = `

/* ───────────────────────────────────────────── */
/* User profiles                               */
/* ───────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS rolling_profiles (
    user_id VARCHAR(20) PRIMARY KEY,
    balance BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS rolling_profiles_balance
    ON rolling_profiles(balance);


/* ───────────────────────────────────────────── */
/* Item definitions                            */
/* ───────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS rolling_items (
    id SERIAL PRIMARY KEY,

    name VARCHAR(100) NOT NULL UNIQUE,

    description TEXT,

    /* 1 / X chance */
    roll_chance BIGINT NOT NULL,

    enabled BOOLEAN NOT NULL DEFAULT TRUE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS rolling_items_enabled
    ON rolling_items(enabled);

CREATE INDEX IF NOT EXISTS rolling_items_chance
    ON rolling_items(roll_chance);


/* ───────────────────────────────────────────── */
/* Aura definitions                            */
/* ───────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS rolling_auras (
    id SERIAL PRIMARY KEY,

    name VARCHAR(100) NOT NULL UNIQUE,

    description TEXT,

    /* 1 / X chance */
    roll_chance BIGINT NOT NULL,

    enabled BOOLEAN NOT NULL DEFAULT TRUE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS rolling_auras_enabled
    ON rolling_auras(enabled);

CREATE INDEX IF NOT EXISTS rolling_auras_chance
    ON rolling_auras(roll_chance);


/* ───────────────────────────────────────────── */
/* User inventory (consumables)                */
/* ───────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS rolling_user_items (
    user_id VARCHAR(20) NOT NULL,

    item_id INTEGER NOT NULL
        REFERENCES rolling_items(id)
        ON DELETE CASCADE,

    quantity BIGINT NOT NULL DEFAULT 0,

    PRIMARY KEY (user_id, item_id)
);

CREATE INDEX IF NOT EXISTS rolling_user_items_user
    ON rolling_user_items(user_id);

CREATE INDEX IF NOT EXISTS rolling_user_items_item
    ON rolling_user_items(item_id);


/* ───────────────────────────────────────────── */
/* Owned auras                                */
/* duplicates allowed                          */
/* ───────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS rolling_user_auras (
    id SERIAL PRIMARY KEY,

    user_id VARCHAR(20) NOT NULL,

    aura_id INTEGER NOT NULL
        REFERENCES rolling_auras(id)
        ON DELETE CASCADE,

    obtained_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS rolling_user_auras_user
    ON rolling_user_auras(user_id);

CREATE INDEX IF NOT EXISTS rolling_user_auras_aura
    ON rolling_user_auras(aura_id);

`;
