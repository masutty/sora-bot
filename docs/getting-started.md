# Getting started

From zero to the bot answering in your server.

- [1. Create the Discord app](#1-create-the-discord-app)
- [2. Run locally](#2-run-locally)
- [3. Invite the bot](#3-invite-the-bot)
- [4. Run with Docker](#4-run-with-docker)
- [5. Deploy](#5-deploy)
- [Troubleshooting](#troubleshooting)

## 1. Create the Discord app

1. Open the [Developer Portal](https://discord.com/developers/applications) and create an application.
2. Under **General Information**, copy the **Application ID** → `BOT_CLIENT_ID`.
3. Under **Bot**, generate the token → `BOT_TOKEN`.
4. Still under **Bot**, enable the **Privileged Gateway Intents**:
   - **Server Members Intent**
   - **Message Content Intent**

> [!WARNING]
> Without both privileged intents the bot can't connect (login fails with `Used disallowed intents`). **Message Content** is what makes prefix commands (`!ping`) work.

## 2. Run locally

You need [Bun](https://bun.sh) ≥ 1.4 and a PostgreSQL. If you don't have one, start just the compose database:

```bash
docker compose up -d db
```

Set up the environment:

```bash
cp .env.example .env.local
```

```dotenv
# .env.local (minimum)
BOT_TOKEN=...
BOT_CLIENT_ID=...
POSTGRES_DB=sorabot
POSTGRES_PASSWORD=postgres
OWNER_IDS=your_user_id
DEV_GUILD_ID=your_test_server_id
```

> [!NOTE]
> **Which file is read?** `bun run dev` sets `NODE_ENV=development` and reads **`.env.local`**. `bun run start` (and Docker) use `NODE_ENV=production` and read **`.env`**. A value missing from `.env.local` can still come from `.env`.

Start the bot:

```bash
bun install
bun run dev
```

A healthy boot ends like this:

```
info  [core.bootstrap] Starting...
info  [core.botclient] Connected as SoraBot#1234
info  [core.bootstrap] Bot ready. 12 commands loaded.
```

> [!TIP]
> With `DEV_GUILD_ID` set, slash commands are registered only in that server and show up immediately. Without it, registration is **global** and can take a while to appear.

## 3. Invite the bot

The first time, generate the URL in the Developer Portal itself (**OAuth2 → URL Generator**, scopes `bot` + `applications.commands`). Once the bot is in a server, `/bot invite` generates the link for you.

Put your user ID in `OWNER_IDS` to get access to owner commands (`/bot ...`, `/echo`).

## 4. Run with Docker

`docker-compose.yml` starts the bot and a Postgres 16, reading **`.env`**:

```bash
cp .env.example .env
# fill in BOT_TOKEN, BOT_CLIENT_ID, POSTGRES_DB, POSTGRES_PASSWORD

docker compose up -d --build
docker compose logs -f bot
```

- Inside compose the bot always reaches the database at `db:5432`. The `POSTGRES_HOST` from `.env` is ignored there.
- `INSTANCE_NAME` names the containers and the log folder (`./data/<INSTANCE_NAME>/logs`). Change it to run more than one instance on the same machine.
- The image build runs `bun run build`: if the command tree or the types are broken, **the image is not built**.

> [!CAUTION]
> Postgres data lives in the named volume `pgdata`, outside the project folder, on purpose: deploy tools that do a clean checkout (like Dokploy) would wipe a folder bind-mounted under `./data`. **Don't switch it to a bind mount.** `docker compose down -v` deletes the database.

## 5. Deploy

| Branch | Role |
|---|---|
| `dev` | Integration. Work happens here. |
| `main` | Production. Every merge into `main` deploys automatically. |

A deploy is a `dev → main` PR. CI (`.github/workflows/lint.yml`) runs `biome ci` on every PR and push.

Before opening the PR:

```bash
bun run lint
bun test
bun run build
```

## Troubleshooting

<details>
<summary><code>Missing required env var: BOT_TOKEN</code></summary>

The file being read is not the one you edited. In dev it's `.env.local`; in production, `.env`. See [configuration.md](configuration.md#required-variables).
</details>

<details>
<summary>Slash commands don't show up</summary>

- In dev, check `DEV_GUILD_ID`: it must be the server you're testing in.
- Run `/bot sync` (or `!bot sync`) to force registration.
- Run `bun run check:commands`: one invalid builder breaks the whole registration.
</details>

<details>
<summary>A cog didn't load</summary>

The bot starts anyway and logs `N cog(s) failed to load: ...`. Common causes: a `name` shared by two cogs, a duplicate command name, or an import error. `bun run check:commands` catches the first two without starting the bot.
</details>

<details>
<summary><code>!command</code> doesn't answer, but <code>/command</code> does</summary>

The **Message Content Intent** is missing in the Developer Portal, or the server uses a different prefix (`/setprefix`).
</details>
