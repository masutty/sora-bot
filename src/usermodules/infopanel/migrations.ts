export const INFO_PANEL_SCHEMA = `
CREATE TABLE IF NOT EXISTS ip_panels (
    id          SERIAL       PRIMARY KEY,
    guild_id    VARCHAR(20)  NOT NULL,
    name        VARCHAR(100) NOT NULL,
    placeholder VARCHAR(100) NOT NULL DEFAULT 'Pick an option',
    blocks      JSONB        NOT NULL DEFAULT '[]',
    channel_id  VARCHAR(20),
    message_id  VARCHAR(20),
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ip_panels_guild_idx ON ip_panels (guild_id);

CREATE TABLE IF NOT EXISTS ip_options (
    id          SERIAL       PRIMARY KEY,
    panel_id     INT          NOT NULL REFERENCES ip_panels(id) ON DELETE CASCADE,
    position    INT          NOT NULL,
    label       VARCHAR(100) NOT NULL,
    emoji       VARCHAR(64),
    description VARCHAR(100),
    blocks      JSONB        NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS ip_options_panel_idx ON ip_options (panel_id, position);
`;
