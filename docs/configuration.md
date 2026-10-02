# Configuration

Every environment variable, and where to tune what is **not** an environment variable.

> [!NOTE]
> In dev (`bun run dev`) the bot reads `.env.local`; in production (`bun run start`, Docker) it reads `.env`. The commented template is [`.env.example`](../.env.example). Everything is read in [`src/config/index.ts`](../src/config/index.ts).

## Required variables

Without these the bot won't start (`Missing required env var: ...`).

| Variable | Description |
|---|---|
| `BOT_TOKEN` | Bot token (Developer Portal → Bot) |
| `BOT_CLIENT_ID` | Application ID |
| `POSTGRES_DB` | Database name |
| `POSTGRES_PASSWORD` | Database password |

## Database

| Variable | Default | Description |
|---|---|---|
| `POSTGRES_HOST` | `localhost` | Ignored under Docker Compose (always `db`) |
| `POSTGRES_PORT` | `5432` | |
| `POSTGRES_USER` | `postgres` | |
| `DATABASE_SSL` | `false` | `true` only for managed Postgres that requires SSL (RDS, Supabase, Heroku...) |
| `DB_POOL_MAX` | `10` | Max connections in the pool. The bot warns in the log when clients are waiting for a connection |

## Bot

| Variable | Default | Description |
|---|---|---|
| `NODE_ENV` | `development` | Set by the `dev`/`start` scripts; decides which `.env` file is read |
| `OWNER_IDS` | — | Comma-separated IDs. Unlocks `botOwnerOnly` commands |
| `DEFAULT_PREFIX` | `!` | Default prefix. Each server can change it with `/setprefix` |
| `DEV_GUILD_ID` | — | Dev only: registers slash commands in this server only (they show up immediately) |
| `DISABLED_COG_DIRS` | — | **Folder** names (not the cog's `name`) to skip on boot. E.g. `biomehunt,tests` |
| `DEFERRED_PREFIX_COMMAND_MESSAGE` | `Processing...` | Text shown while a prefix command is in `defer()` |
| `DEFAULT_QUIP_JOKE_LEVEL` | `0` | Tone of generic error messages: `0` serious ... `3` jokiest |
| `DEV_ALLOW_ARGS_AS_FLAGS` | `false` | **Experimental.** Accepts `--name value` / `--name=value` in prefix commands |
| `ENCRYPTION_KEY` | — | Key used by `src/utils/crypto.ts` |

> [!WARNING]
> Changing `ENCRYPTION_KEY` makes any data already encrypted with the previous key unreadable.

## Logging

| Variable | Default | Description |
|---|---|---|
| `LOG_LEVEL` | `debug` | Level written to `logs/combined-*.log` |
| `CONSOLE_LOG_LEVEL` | `info` | Level printed to the terminal |
| `LOG_RETENTION_DAYS` | `14` | Days of logs kept before deletion |
| `LOG_MAX_SIZE` | — | Rotates before the day ends if a file passes this size (e.g. `20m`) |

Levels, least to most detail: `error`, `warn`, `info`, `debug`, `verbose`. You can change them at runtime with `/bot log set`. See [operations.md](operations.md#logs).

## Docker

| Variable | Default | Description |
|---|---|---|
| `INSTANCE_NAME` | `sorabot` | Name of the containers and of the `./data/<name>/logs` folder |

## What isn't an environment variable

Three places in the code tune behavior. Pick the right one:

| Where | What goes there | Example |
|---|---|---|
| `config.ui` in [`src/config/index.ts`](../src/config/index.ts) | UI defaults for **every** module | `viewTimeoutMs`, `confirmTimeoutMs`, `flowStepTimeoutMs` |
| `settings.ts` at the module root | How **this module** behaves: timing, limits | A worker's interval |
| The module's `constants/` | What the domain **is**. Never changes at runtime | Biome names, level table |

> [!TIP]
> Rule of thumb: if you can change the value without changing what the feature *means*, it goes in `settings.ts`. If it changes a game rule, it goes in `constants/`.

> [!IMPORTANT]
> `!bot reload` does **not** re-read `config`. Changed `.env`? Restart the process.
