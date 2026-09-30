# Operations

How to run the bot day to day: the `/bot` command, logs and hot reload.

## The `/bot` command

Only for users in `OWNER_IDS`. Hidden from `/help`.

| Subcommand | What it does | Prefix? |
|---|---|:---:|
| `/bot status` | Overview panel: memory, DB pool, event loop | ✅ |
| `/bot reload` | Hot reloads all code without restarting the process | ✅ |
| `/bot sync` | Re-registers slash commands with Discord | ✅ |
| `/bot shutdown` | Shuts the bot down cleanly | ✅ |
| `/bot mod unload name:<cog>` | Unloads a cog at runtime | ✅ |
| `/bot log set level:<level> [target]` | Changes the console or file log level, no restart | ✅ |
| `/bot log show` | Shows the current levels | ✅ |
| `/bot ping` | WebSocket and database latency | slash |
| `/bot memory` | Process memory and CPU | slash |
| `/bot db` | Connection pool detail | slash |
| `/bot event-loop` | Event-loop lag (p50/p95/p99) | slash |
| `/bot commands` | Registered commands, by cog | slash |
| `/bot servers` | Servers the bot is in | slash |
| `/bot uptime` | Process uptime | slash |
| `/bot invite` | Invite link | slash |

> [!NOTE]
> Subcommands marked **slash** show internals (servers, database target, memory). That's why they only exist as an ephemeral slash reply and are never posted to a channel via prefix.

## Hot reload

`/bot reload` (or `!bot reload`) unloads every cog, clears the module cache for `src/` and loads everything again. Workers stop and restart, and changed migrations run.

> [!IMPORTANT]
> Reload does **not** reload `config`, the database connection, the logger or the metrics: they hold live state. Changed `.env` or one of those files? Restart the process.

If a cog fails during reload, the others still load and the command replies with an error listing what was left out.

## Logs

| Destination | Controlled by | Default |
|---|---|---|
| Terminal | `CONSOLE_LOG_LEVEL` | `info` |
| `logs/combined-*.log` | `LOG_LEVEL` | `debug` |
| `logs/error-*.log` | fixed | `error` only |

Files rotate daily and are kept for `LOG_RETENTION_DAYS` days (default 14). Under Docker they live in `./data/<INSTANCE_NAME>/logs`.

### Tracing an invocation by its `ref`

Every entry point (command, click, worker tick, cog event) gets an 8-character `ref`. Every log made "below" it, in services, repositories and views, carries that `ref`:

```
info  [core.commands] (ref=xv6qvdt2 !bh-stats users u=masutty(1888…) g=1289…): invoked
info  [core.commands] (ref=xv6qvdt2 …): replied in 812ms
info  [core.view.run] (ref=xv6qvdt2.2:tab:active …): click tab:active
info  [core.commands] (ref=xv6qvdt2 …): ok in 96230ms
```

When a user gets an internal error, the message ends with `-# ref: xv6qvdt2`. To see everything that invocation did:

```bash
grep "ref=xv6qvdt2" logs/combined-*.log
```

> [!TIP]
> A high total time on a command that opened a View isn't slowness: the total includes the time the View stayed open. The View's `closed: done|expired|failed` line explains it. The latency the user feels is the `replied in` one.

Format details, and how workers, events and components are traced: [`src/core/README.md` §8](../src/core/README.md#8-logging--traceability).

## Before deploying

```bash
bun run lint          # Biome
bun test              # tests
bun run build         # validates commands + assets + types (the same thing Docker runs)
```

> [!WARNING]
> A command name repeated across two cogs, or two cogs with the same `name`, **fail the build**, even if one of them is in `DISABLED_COG_DIRS`. The build doesn't know which `.env` will run.
