-- ─────────────────────────────────────────────────────────────────────────────
-- Discord Bot Framework - Schema
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Core ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS guilds (
  id          VARCHAR(20)  PRIMARY KEY,            -- Discord snowflake
  prefix      VARCHAR(10)  NOT NULL DEFAULT '!',
  settings    JSONB        NOT NULL DEFAULT '{}',  -- Dados livres por módulo
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- GIN index para queries no JSONB (ex: settings->>'welcome_channel')
CREATE INDEX IF NOT EXISTS idx_guilds_settings ON guilds USING gin(settings);

-- Tracking de migrações
CREATE TABLE IF NOT EXISTS _migrations (
  name       VARCHAR(255) PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Módulo: Welcome ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS welcome_configs (
  guild_id    VARCHAR(20)  PRIMARY KEY REFERENCES guilds(id) ON DELETE CASCADE,
  channel_id  VARCHAR(20),
  message     TEXT         NOT NULL DEFAULT 'Bem-vindo(a) ao servidor, {user}!',
  enabled     BOOLEAN      NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── Template para módulo customizado ─────────────────────────────────────────
-- Cada módulo cria suas próprias tabelas referenciando guilds(id).
-- Ex: módulo de economia

-- CREATE TABLE IF NOT EXISTS economy_wallets (
--   guild_id   VARCHAR(20) REFERENCES guilds(id) ON DELETE CASCADE,
--   user_id    VARCHAR(20) NOT NULL,
--   balance    BIGINT      NOT NULL DEFAULT 0,
--   updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
--   PRIMARY KEY (guild_id, user_id)
-- );
