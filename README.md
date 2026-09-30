<div align="center">

# sora-bot

**A modular TypeScript framework for Discord bots, and the modules built on top of it.**

![Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)
![discord.js](https://img.shields.io/badge/discord.js-v14-5865f2?logo=discord&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169e1?logo=postgresql&logoColor=white)
![Biome](https://img.shields.io/badge/lint-Biome-60a5fa?logo=biome&logoColor=white)

</div>

---

## Features

- **Cogs**: each feature is a folder with a `defineCog(...)`. The loader discovers and loads it on its own.
- **One `run(ctx)` per command**: it serves slash (`/ping`) and prefix (`!ping`) at the same time.
- **Views**: stateful interactive messages (buttons, selects, modals, typed text), with ready-made helpers: `paginate`, `tabs`, `confirm`, `flow`.
- **Workers** and **persistent components**: background loops, and buttons that survive a restart.
- **Per-cog migrations**, idempotent and tracked by hash.
- **Traceability**: every invocation gets a `ref` that shows up in all of its logs.
- **Hot reload**: `!bot reload` reloads the code without restarting the process.

## Quick start

> [!IMPORTANT]
> You need [Bun](https://bun.sh) ≥ 1.4 and a reachable PostgreSQL (or Docker).

```bash
cp .env.example .env.local   # in dev the bot reads .env.local; in production, .env
# fill in BOT_TOKEN, BOT_CLIENT_ID, POSTGRES_DB, POSTGRES_PASSWORD

bun install
bun run hooks:install        # optional: lint staged files before each commit
bun run dev
```

Migrations run automatically on boot. You don't need to run `db:migrate` first.

> [!TIP]
> Set `DEV_GUILD_ID` in `.env.local`. In dev, slash commands are then registered only in that server and show up immediately. Without it, registration is global and can take a while to propagate.

Full walkthrough (Discord app setup, Docker, deploy): **[docs/getting-started.md](docs/getting-started.md)**.

## Scripts

| Command | What it does |
|---|---|
| `bun run dev` | Starts the bot with `NODE_ENV=development` (reads `.env.local`) |
| `bun run start` | Starts the bot with `NODE_ENV=production` (reads `.env`) |
| `bun run build` | Validates the command tree, the assets and the types (emits nothing) |
| `bun run check:commands` | Command validation only: duplicate names, invalid builders |
| `bun test` | Runs the tests |
| `bun run lint` / `lint:fix` | Biome check / check with fixes |
| `bun run db:migrate` | Runs the base migrations manually |

## Layout

```
src/
├── index.ts          # Bootstrap: migrations → cogs → handlers → login
├── define.ts         # The framework's public API. Modules import ONLY from here (@/define)
├── config/           # Reads the env and defines the UI defaults
├── core/             # The framework: commands, views, workers, components, cog loader
├── database/         # pg pool, query(), transaction(), migrations
├── utils/            # Logger, trace, cache, formatting
├── modules/          # Native cogs (core, bot_internals). Loaded first
└── usermodules/      # Project cogs (biomehunt, tests, ...)
```

## Creating a cog

```ts
// src/usermodules/hello/index.ts
import { defineCog, defineCommand } from "@/define";

const hello = defineCommand({
    name: "hello",
    description: "Says hi.",
    async run(ctx) {
        await ctx.reply(`Hi, ${ctx.user.username}!`);
    },
});

export default defineCog({
    name: "hello",
    description: "Minimal example.",
    authors: [{ name: "you", id: 0n }],
    commands: [hello],
});
```

Restart the bot (or run `!bot reload`) and both `/hello` and `!hello` exist.

> [!NOTE]
> The folder name does not identify the cog: the `name` does, and it must be unique across `modules/` and `usermodules/`. The folder name only matters for `DISABLED_COG_DIRS`.

A full example with migrations, events, a worker, a view and a persistent button: **[docs/creating-a-cog.md](docs/creating-a-cog.md)**.

## Documentation

| Document | Contents |
|---|---|
| [docs/getting-started.md](docs/getting-started.md) | Local setup, Discord app, Docker, deploy |
| [docs/configuration.md](docs/configuration.md) | Every environment variable, and where to tune everything else |
| [docs/creating-a-cog.md](docs/creating-a-cog.md) | Tutorial: a complete cog from scratch |
| [docs/operations.md](docs/operations.md) | The `!bot` command, logs, `ref`, hot reload |
| [src/core/README.md](src/core/README.md) | Framework reference: commands, views, helpers, workers, testing |

## Architecture decisions

| Decision | Reason |
|---|---|
| `@/define` as the only entry point | The core can change internally without breaking modules |
| One `run(ctx)` for slash and prefix | One implementation per command, no duplicated logic |
| Filesystem discovery | Adding a module = creating a folder, no manual registration |
| `pg` without an ORM | Full control over queries; JSONB for flexible data |
| Migrations tracked by hash | Changed SQL is re-applied automatically; unchanged SQL never runs again |
| In-memory prefix cache | Avoids one query per message |
| `transaction()` wrapper | Automatic rollback on any error |
