# `src/core` — the command/view framework

`src/core/*` is the bot's framework: how commands are declared and dispatched, and how stateful
Discord messages ("Views") are rendered and driven. Modules (`src/modules/<name>/*`) never import
from `src/core/*` directly — everything the framework exposes goes through `@/define`, the one
public gate (`src/define.ts`). This keeps the framework's internal wiring (`view-engine.ts`,
`discord-transport.ts`, `command-dispatch.ts`, ...) free to change without touching every module.

This document describes the API **as it is now** (post `refactor/view`), not the original design —
read the TSDoc in `src/core/view/*.ts` and `src/core/command/*.ts` for the authoritative detail;
this is the guided tour.

## 1. The ideal module

A module lives at `src/modules/<name>/`, named after the module (e.g. `biomehunt`). Reference
example: `src/modules/biomehunt/`.

```
src/modules/<name>/
    index.ts            # defineCog(...) - the module's entry point (see below)
    types.ts             # domain types + the module's error class (extends UserFacingError)
    settings.ts          # module tunables - how the module *behaves* (optional; see §5)
    migrations.ts        # SQL schema strings run on load (optional)

    commands/
        <name>.command.ts        # defineCommand(...)

    views/
        <name>.view.ts            # defineView(...) screens (`c.open`-able), or a pure
                                    # payload-builder used outside a View session too
        <name>.view.test.ts        # fake-transport tests (see §7), next to the view
        <shared-helper>.ts         # a non-screen helper shared by several views (no suffix
                                    # required - e.g. stats-builders.ts)

    flows/
        <name>.flow.ts             # flow(...) wizards built from views/ steps

    services/
        <name>.service.ts          # business logic: orchestrates repository/ + Discord side
                                     # effects (BotClient), independent of any View

    repository/
        <name>.repository.ts       # DB access only - rows in, rows out, no Discord.js types

    constants/
        <name>.constants.ts        # static domain data (game rules) - never changes at runtime

    workers/
        <name>.worker.ts            # background interval loops started from onReady
```

Only `index.ts`, `types.ts`, `settings.ts` and `migrations.ts` are allowed loose at the module's
root — everything else lives in a suffixed file under one of the folders above. Filenames are
kebab-case; the suffix names the folder it belongs to (`*.command.ts`, `*.view.ts`, `*.flow.ts`,
`*.service.ts`, `*.repository.ts`, `*.constants.ts`, `*.worker.ts`). A module can add its own
domain-specific subfolder when it needs one (e.g. biomehunt's `macro-parsers/*.parser.ts`) — the
suffix convention still applies inside it.

**Dependency direction** (observed and enforced by `biomehunt`, the reference module):

- Every module imports the command/view framework **only** through `@/define` — never
  `@/core/view/*` or `@/core/command/*`. (`@/core/bot-client`'s `BotClient` *type* is fine to
  import directly; it isn't the View/Command framework.)
- `commands/` → `views/`, `flows/`, `services/`. This is the only layer that starts a session
  (`ctx.open(...)`) from a real invocation.
- `views/`/`flows/` → `services/`, `constants/`, `repository/` (read-only display data — e.g.
  `stats-builders.ts` reads straight from `repository/` to build a stats screen), and other
  `views/`/`flows/` (a parent opening a child with `c.open`, or a flow reusing a step from
  another module's `views/`). Never `commands/`.
- `services/` → `repository/`, `constants/`, other `services/`, and a pure (non-interactive)
  message builder exported from `views/` — never a `defineView` screen itself — reused outside a
  View session, e.g. `services/activity-session-report.service.ts` → `views/session-end.view.ts`.
- `workers/` → `services/`, `repository/`.
- `repository/` → `@/database/connection`, `constants/`, `@/utils/cache`, other `repository/`
  modules (plus `types.ts` for row types).
- A subsystem subfolder (e.g. biomehunt's `macro-parsers/*.parser.ts`) is only imported through
  its own `index.ts` — never a file inside it directly.
- Never: a `services/`, `workers/` or `repository/` module importing an **interactive** View
  (`defineView`) or a `commands/` module.
- `index.ts` wires it all together: lists `commands/` in `commands: [...]`, wires `events`/
  `onReady` to `services/`/`repository/`, starts `workers/`, and registers `migrations.ts`.

## 2. Commands

Declare a command with `defineCommand` (from `@/define`); export it as the file's default:

```ts
import { SlashCommandBuilder } from "discord.js";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";

export default defineCommand({
    name: "ping",
    description: "Latency check.",
    category: CommandCategory.UTILITY,

    options: new SlashCommandBuilder(),

    async run(ctx) {
        await ctx.reply(`Pong! ${Date.now() - ctx.createdTimestamp}ms`);
    },
});
```

Write **one** `run(ctx)` — it serves both slash and prefix invocations through the same
`CommandContext`. The framework handles, before `run` is called: `guildOnly`, guards
(`botOwnerOnly`/`adminOnly`/`allowedUsers`/`permissions`), prefix usage for a missing/unknown
subcommand, and `modes`/`subcommandModes`. After `run` returns or throws: a thrown
`UserFacingError` is shown verbatim; anything else is logged and answered with a generic quip.

- **`ctx.args`** (`CommandArgs`) — one API for both modes. Primitive getters
  (`getString`/`getInteger`/`getNumber`/`getBoolean`) return `null` only when the option is
  **absent**; `required: true` turns that into a thrown "Missing required argument" instead.
  Supplied-but-unparseable (e.g. `2.5` for an integer on prefix) always throws a type error —
  never silently `null`. Entity getters (`getUser`/`getMember`/`getChannel`/`getRole`) are
  `async`; they return `null` only when the option wasn't supplied — supplied-but-unresolvable
  (a user who left, a garbage mention) throws, so a bad target is never mistaken for "not given"
  (which would e.g. show the invoker's own profile by accident).
- **`ctx.reply`/`ctx.defer`/`ctx.editReply`/`ctx.replyUsage`** — replying is stateful:
  the 1st `reply()` becomes the command's response (or fills the `defer()`ed one); later
  `reply()`s are follow-ups; `editReply()` edits the first response. `replyUsage()` sends this
  command's auto-generated usage (the same screen shown for a missing prefix subcommand).
- **`guildOnly: true`** — hidden in DMs, a DM call is refused before `run`, and `run` receives a
  `GuildCommandContext` (`guild`/`member` non-null, no `!` needed).
- **`modes`** (`"both" | "slash" | "prefix"`, default `"both"`) — where the command exists at
  all; `"prefix"` means it's never registered as a slash command. **`subcommandModes`** does the
  same per-subcommand, keyed `"sub"`, `"group"` (every sub in it) or `"group:sub"` (most specific
  wins); a `"prefix"` subcommand is stripped from slash registration, a `"slash"` one answers a
  prefix caller with "only available as a slash command".
- **`onMissingSubcommand`** (default `"usage"`) — a prefix call with no/unknown subcommand
  replies with the usage and never calls `run`. `"run"` calls `run` anyway, with
  `ctx.args.getSubcommand() === null` (and `getSubcommandGroup()` set for a bare group).
- **`UserFacingError`** — throw it for an expected, user-caused failure (bad input, missing
  config, a target that doesn't exist); its `.message` is shown verbatim, so it must never leak
  internals. Modules subclass it for their own domain (e.g. `BiomeHuntError`).
- **Ephemeral on prefix + `ttlMs`** — slash `ephemeral: true` is a real ephemeral message; prefix
  has no such thing, so the reply is sent **publicly** and deleted after `ttlMs` (default
  `config.ui.prefixEphemeralTtlMs`). For `reply()` the countdown starts at send time and doesn't
  reset on clicks; for `ctx.open(view, input, { ephemeral: true, ttlMs })` it starts once the
  View's session **ends** (done or expired), so an open View is never deleted out from under the
  user mid-session.
- **Overrides and `ctx.raw`** — `executeAsSlash`/`executeAsPrefix`, when present, replace `run` in
  *that* mode only (an escape hatch for a truly different flow per mode); prefer `modes`/
  `subcommandModes` over this. `ctx.raw` (`{ kind: "slash", interaction }` or
  `{ kind: "prefix", message, args }`) is the typed escape hatch for a rare mode-specific need
  (e.g. reading a prefix message's attachment) — prefer declaring modes over branching on it. One
  trap: after `ctx.defer()`, don't fill the deferred response through
  `ctx.raw.interaction.editReply` — the next `ctx.reply` would try to edit it again instead of
  following up. Use `ctx.reply` for that first response.

## 3. Views

A View is a stateful message: `render(state, kit)` turns the current state into a message,
handlers in `on` react to clicks/selects/typed text and change the state, and the engine redraws
after each one. Declare one with `defineView` (from `@/define`) and run it with
`ctx.open(view, input, opts)` from a command, or `c.open(childView, input)` from inside another
View's handler.

### Mental model

```
state --render(state, kit)--> message shown on Discord
   ^                                     |
   |                              user clicks / types / submits a modal
   |                                     v
   +------ handler mutates/returns a new state <---+
                       |
                (engine redraws)
```

`start` runs once when the instance is created (before anything is shown); `render` must stay
pure and fast — no I/O, only `initial`/`start`/handlers do I/O.

### A counter, end to end

```ts
import { ButtonStyle } from "discord.js";
import { defineView, type ViewDefinition } from "@/define";

interface CounterState {
    count: number;
}

export function counterView(): ViewDefinition<CounterState, void, void> {
    return defineView<CounterState, void, void>({
        name: "core.example-counter",
        initial: () => ({ count: 0 }),
        render: (state, kit) => ({
            content: `Count: **${state.count}**`,
            components: [
                kit.row(
                    kit.button("dec", (b) => b.setLabel("-1")),
                    kit.button("inc", (b) => b.setLabel("+1").setStyle(ButtonStyle.Primary)),
                    kit.button("done", (b) => b.setLabel("Done").setStyle(ButtonStyle.Success)),
                ),
            ],
        }),
        on: {
            inc: (c) => {
                c.state.count += 1;
            },
            dec: (c) => {
                c.state.count -= 1;
            },
            done: (c) => c.done(),
        },
    });
}

// await ctx.open(counterView(), undefined);
```

- **`name`** — `<cog>.<name>` (e.g. `"biomehunt.profile"`); goes into every customId and the logs.
- **`kit`** (`RenderKit`) — builds every interactive component, bound to a `key`: `kit.button`,
  `kit.stringSelect`/`channelSelect`/`roleSelect`/`userSelect`, and `kit.row(...)`. Never set a
  customId by hand — the kit builds `<viewName>:<instanceId>:<key>` itself (checked against
  Discord's 100-char limit, throwing with the view/key name if it's too long), so two open copies
  of the same View never see each other's clicks. The handler for a click on key `"inc"` is
  `on.inc`.
- **State: mutable vs returned** — a handler may mutate `c.state` in place (`c.state.count += 1`)
  **or** return a new state object (`return { ...c.state, count: c.state.count + 1 }`); both are
  equivalent, mutation is just less typing. A handler returning nothing leaves whatever it
  mutated as-is.
- **`done(result)`** — ends *this* view; whoever opened it (`ctx.open`/`c.open`) resolves with
  `result`. When the ROOT calls `done`, its final render is painted immediately with interactive
  components stripped (Link buttons are kept) and the session ends. A child instead hands the
  message straight back to its opener, which redraws.

### Child views with `open` — a reusable picker

`c.open(child, input)` opens `child` as a child of the current instance, on the **same message**,
and resolves with its result once it's `done`. Only the top instance receives events; the child's
own `timeoutMs`/`onExpire` are ignored — the whole session has one idle clock and one expiry
screen, both the root's (see "Timeouts and expiry" below). This is how a picker is built once and
reused wherever a "pick one of these" screen is needed — see `forwardRemoveView` in
`src/modules/biomehunt/views/forward-remove.view.ts`:

```ts
// A reusable picker: resolves the picked item, or `undefined` on Back/Cancel.
interface PickerInput<T> {
    items: T[];
}
interface PickerState<T> {
    items: T[];
}

function pickerView<T>(label: (item: T) => string): ViewDefinition<PickerState<T>, T | undefined, PickerInput<T>> {
    return defineView<PickerState<T>, T | undefined, PickerInput<T>>({
        name: "core.example-picker",
        initial: (input) => ({ items: input.items }),
        render: (state, kit) => ({
            content: state.items.map((item, i) => `${i + 1}. ${label(item)}`).join("\n"),
            acceptText: true,
            components: [kit.row(kit.button("back", (b) => b.setLabel("Back")))],
        }),
        on: { back: (c) => c.done(undefined) },
        onText: async (c) => {
            const n = Number(c.text.trim());
            if (!Number.isInteger(n) || n < 1 || n > c.state.items.length) {
                await c.notify(`Enter a number between 1 and ${c.state.items.length}.`);
                return;
            }
            c.done(c.state.items[n - 1]);
        },
    });
}

// Inside a parent view's handler:
// remove: async (c) => {
//     const picked = await c.open(pickerView(formatLine), { items: c.state.list });
//     if (picked) await deps.remove(picked);
// },
```

If the session expires while a child is open, `c.open`'s promise (and every other pending
`open`, and the root's own `ctx.open`/`runView`) resolves `undefined` — always check for it before
acting on the result.

### Modals

`c.modal(spec)` shows a modal — but **only** as the first answer to a button/select click, before
any slow work (Discord allows ~3s to acknowledge a click; after that the engine has already
acknowledged it). Not from `start`, not from `onText`, not after a `notify`/`open`/another modal in
the same handler, and never in answer to a modal submit (Discord can't show a modal from a modal).
So "invalid value → ask again" is: `c.notify(...)` and let the user click the button again —
misuse of `c.modal` throws a clear error. While a modal is open the View's idle timer is paused.
It resolves with `Record<string, string>` keyed by each field's `key`, or `null` if closed/expired.
Discord never reports a dismissed (Esc) modal to the bot: the **next accepted click** on this
view cancels the parked modal (it resolves `null`, that earlier handler run finishes) and then
runs normally — a re-show attempt instead just `notify`s and waits for another click.

```ts
fill: async (c) => {
    const v = await c.modal({
        title: "Set threshold",
        fields: [{ key: "hours", label: "Hours", value: String(c.state.hours) }],
    });
    if (!v) return; // closed/expired/cancelled by a new click - state unchanged
    const hours = Number(v.hours);
    if (Number.isNaN(hours) || hours <= 0) {
        await c.notify("Enter a positive number.");
        return;
    }
    c.state.hours = hours;
},
```

### Typed text (`acceptText`/`onText`/`deleteTextInput`)

A screen with `acceptText: true` in its render accepts a plain message from the View's owner in
its channel, routed to `onText(c)` where `c.text` is the message content; return the new state, or
`c.notify(...)` and keep the current one to refuse it. `deleteTextInput: true` (default `false`)
deletes the typed message after it's consumed (needs Manage Messages; fails silently without it).

### Access

`access` (default `"invoker"`) controls who can interact: `"invoker"` (only whoever opened it —
click from anyone else gets an ephemeral "not yours", doesn't reset the idle timer), `"anyone"`,
or a predicate `(user: User) => boolean`.

### Timeouts, expiry and `beforeExpire`

The session has **one idle clock and one expiry screen, both owned by the root** — a child's own
`timeoutMs`/`onExpire` are ignored entirely; only the root's apply for the whole session. The
clock is renewed by every accepted interaction, paused while a modal is open, and — importantly —
**a session never expires while an instance is running its own handler/`start` code**: merely
being parked (`c.open` waiting on a child, `c.modal` waiting on a submit) does *not* count and
still expires normally, but if the idle deadline is reached mid-handler, expiry waits for that run
to settle first; that settling itself counts as activity, arming the clock fresh for a full
`timeoutMs` — so a slow "Apply Now" still gets its own render before anything can expire under it.

`onExpire` (root only, default `"strip"`) is the session's final screen:
- `"strip"` — drops action rows / button accessories from whatever screen was showing, keeps the
  content and **Link buttons** (they need no listener, so they keep working after the View closes).
- `"disable"` — keeps every component, with buttons/selects disabled (Link buttons untouched).
- a function `(state: S) => ViewPayload | Promise<ViewPayload>` — gets the **root's** state,
  returns a whole new final payload (e.g. `EmbedFormatter.warn("Expired.")`).

`beforeExpire(state)` runs on expiry for every open instance, root to the deepest child, before
the final payload is built (e.g. `rerollView` auto-applies the pending draw before showing "done")
— except an instance whose handler (or `start`) is running its own code at that moment, so a slow
action is never applied twice. In practice this exception is now mostly unreachable directly
(expiry is already postponed while anything runs its own code, per above) — it's kept as defense
in depth.

### Errors in a handler

A handler that throws is not shown to the user directly: the engine logs it and leaves the View
open (unlike a command-level error, which ends the interaction). Prefer catching expected failures
yourself and turning them into a new state/screen (see `confirm`'s `onConfirm` handling in §4) —
reserve an uncaught throw for genuine bugs.

### Discord limits the engine enforces for you

- **customId length** — `viewCustomId` throws (naming the view and key) if
  `<viewName>:<instanceId>:<key>` would exceed Discord's 100-char cap.
- **Buttons per row** — `navRow` throws if it would exceed Discord's 5-buttons-per-row cap; pass
  fewer `extra` buttons or `skipLabel: false`.
- **`allowedMentions`** — every View payload gets `allowedMentions: NO_PINGS` by default unless
  the render passes `allowedMentions` explicitly — a screen that echoes a role/user mention (e.g.
  "Active role: <@&123>") never pings anyone just for being displayed.

## 4. Helpers

Built on top of `defineView`, exported from `@/define`. Prefer one of these over a hand-rolled
View whenever the shape fits.

### `paginate` / `paginationRow` / `paginationHandlers`

`paginate({ name, pages, renderPage })` is a ready-made `[<<] [<] [n / N] [>] [>>]` View: `<`/`>`
wrap around, `<<`/`>>` jump to the ends (disabled there), the middle button opens a "Jump to page"
modal. Building a custom paginated screen (its own buttons, a result)? Compose the two pieces it's
built from instead:

```ts
render: (s, kit) => ({ ...list(s.page), components: [paginationRow(kit, s.page, pages), ...] }),
on: { ...paginationHandlers({ pages: (s) => Math.ceil(s.items.length / 10) }), back: (c) => c.done(null) },
```

### `tabs`

`tabs({ name, initial, tabs, renderTab, onTabChange, disableActive })` — a button per tab (active
one `Primary`, disabled by default; `disableActive: false` leaves it clickable, still switching
`state.tab` and re-running `onTabChange`) below the active tab's content plus its own `extraRows`.
`initial` is a function (loads the data + the tab to open on); `onTabChange(state, key)` runs after
a click sets `state.tab`, mutate-or-return like a normal handler.

### `confirm`

`confirm({ name, title, fields, onConfirm })` — a yes/no gate: `[Confirm] [Cancel]` over a summary
container. Resolves `true` once confirmed **and** `onConfirm` succeeded (its payload becomes the
final screen); `false` on Cancel or if `onConfirm` throws (a `UserFacingError`'s message is shown,
anything else logged + "Error running the action!"); `undefined` on idle expiry. `onConfirm` may be
slow — the click is acknowledged immediately, `onConfirm` runs after.

### `flow`

`flow({ name, context, steps, onFinish, onCancel?, onTimeout? })` — runs `steps` in order as
children on one message: step 1 shows immediately, and each step is a View (opened with the
flow's `context` as its input) that ends with a `StepResult` object — `c.done({ kind: "ok" })`:
`{ kind: "ok" }`/`{ kind: "skip" }` advance, `{ kind: "back" }` goes to the previous step (stays
on the first), `{ kind: "cancel" }` ends the whole flow with `onCancel`. After the last step, `onFinish(context)`'s payload is the final screen. The flow owns
the session's one clock: `stepTimeoutMs` (default `config.ui.flowStepTimeoutMs`) idle in *any*
step ends it with `onTimeout` (default `onCancel`). Build a step's own screen with `navRow` +
`navHandlers()`:

```ts
render: (_s, kit) => ({ ...body, components: [navRow(kit, { canBack: true, skipLabel: "Next" })] }),
on: { ...navHandlers() },
```

**Two steps, one reused**: `src/modules/biomehunt/flows/ez-setup.flow.ts` is the canonical
example — most of its own steps (`welcomeStep`, `categoriesStep`, ...) live right there, but its
*last* step is `forwardListView(deps.forwards, "step")` from
`src/modules/biomehunt/views/forward-list.view.ts` — the exact same View also runs **standalone**
(`forwardListView(deps, "close")`) from `src/modules/biomehunt/flows/forward-config.flow.ts`'s own
`bh-admin forward menu`. One `defineView`, two call sites, its `exit: "close" | "step"` parameter
picking the right exit row/result type for each:

```ts
// flows/ez-setup.flow.ts (excerpt)
return flow<EzSetupContext>({
    name: "biomehunt.ez-setup",
    context,
    steps: [welcomeStep(deps), categoriesStep(deps) /* , ...more */, forwardListView(deps.forwards, "step")],
    onFinish: (ctx) => buildSummary(ctx, deps),
});

// flows/forward-config.flow.ts - the SAME view, opened directly, no flow involved
await ctx.open(forwardListView(deps, "close"), { guildId });
```

## 5. Config

Three different places tune behavior — pick the right one:

- **`config.ui`** (`src/config/index.ts`) — framework-wide UI *defaults*, not env-driven: one
  place to tune how every command/View behaves unless a module overrides it (`viewTimeoutMs`,
  `confirmTimeoutMs`, `modalTimeoutMs`, `flowStepTimeoutMs`, `prefixEphemeralTtlMs`). Change this
  when the change should apply to every module.
- **`settings.ts`** (module root, e.g. `src/modules/biomehunt/settings.ts`) — how *this module*
  behaves: timing, limits, thresholds specific to it (`rerollIdleMs`, `quotaReplyTimeoutMs`,
  worker tick rates). Changing a value here must never change a game/domain rule.
- **`constants/`** (module folder) — what the domain *is*: fixed game/domain data that doesn't
  change at runtime at all (biome names, badge metadata, level thresholds). If a value could
  reasonably be tuned without changing what the feature *means*, it belongs in `settings.ts`
  instead, not here.

## 6. Logging & traceability

Every command invocation gets a short **`ref`** (8 base36 chars). The command handler runs the
invocation inside a trace context (`src/utils/trace.ts`, an `AsyncLocalStorage`), and **every
`Logger` call anywhere below it** — services, repositories, Views — prints it automatically, with
the command path, mode, user and guild. Nothing is passed around; existing log calls need no change:

```
info  [core.commands] (ref=xv6qvdt2 !bh-stats users u=masutty(1888…) g=1289…): invoked
info  [core.commands] (ref=xv6qvdt2 …): replied in 812ms
info  [core.view.run] (ref=xv6qvdt2.2:tab:active …): click tab:active
info  [core.view]     (ref=xv6qvdt2.4:next …): view biomehunt.stats-users closed: expired after 95410ms
info  [core.commands] (ref=xv6qvdt2 …): ok in 96230ms
```

- **The command log** (`core.commands`): `invoked`, `replied in` (first reply — the latency the
  user feels), then the outcome (`ok` / `user-error` / `error`) with the **total** time. The total
  includes any View the command awaited (`ctx.open` resolves when the View closes), so a long
  total isn't slowness — the View's `closed: <done|expired|failed>` line (`ViewCloseReason`)
  explains it.
- **Views**: a View re-enters its opener's trace for every interaction, as a numbered step
  (`ref.N:key`). Each click, select (with the chosen values), typed text (truncated to 80 chars)
  and modal submit/close is logged, flagged when the actor isn't the invoker.
- **Internal errors** show the ref to the user (`-# ref: xv6qvdt2`) — search the logs for
  `ref=xv6qvdt2` to find everything that invocation did.
- **Not traced yet**: work that doesn't start from a command (webhook `messageCreate` events,
  worker ticks). Wrap it with `runWithTrace({ ref: newTraceRef(), … }, fn)` to give it one.

## 7. Testing a View: the `fake-transport`

`createFakeViewTransport` (from `@/define`) is a TEST-ONLY in-memory `ViewTransport` + manual
clock — never use it outside a test. It records every call the engine makes and lets the test
drive it: emit a click, a typed message, or settle a parked modal, then assert on what got
rendered/notified.

```ts
import { expect, test } from "bun:test";
import { createFakeViewTransport } from "@/define";
import { counterView } from "./counter.view";

test("counter: +1 then Done ends with count 1", async () => {
    const fake = createFakeViewTransport();
    const resultP = fake.run(counterView(), undefined, "owner"); // invokerId defaults to "owner"
    await fake.flush();

    await fake.emit(fake.click("inc", "owner"));
    expect(fake.lastPayload()).toMatchObject({ content: "Count: **1**" });

    await fake.emit(fake.click("done", "owner"));
    expect(await resultP).toBeUndefined(); // counterView's `done()` result type is void
});
```

Useful pieces:

- **`fake.run(view, input, invokerId?)`** — runs `view` as the root on the fake transport/clock,
  resolving like `runView` (the `done` result, or `undefined` on expiry).
- **`fake.click(key, userId, values?)`** / **`fake.clickId(customId, userId, values?)`** — builds
  a component event bound to a key on the *current* message (or an exact customId, e.g. one
  captured from an earlier render); **`fake.text(userId, content)`** — a typed message.
  **`fake.emit(event)`** delivers it and waits for the engine to settle.
- **`fake.clock.advance(ms)`** — moves the manual clock forward, firing every timer that comes due
  (in order) — this is how a test reaches idle expiry (`await fake.clock.advance(timeoutMs)`)
  without a real `setTimeout`.
- **`fake.lastPayload()`** — the payload currently on the "message" (last respond/render);
  **`fake.id(key)`** — the customId bound to `key` on it, if you need it directly.
- **`fake.notifies`**, **`fake.modals`**, **`fake.renders`**, **`fake.log`** — full call history,
  for asserting a `c.notify(...)` fired, a modal was shown with the right spec, or the call order.
- **`fake.modalResult`** — a function `(call) => Promise<{ values, ack } | null>` deciding what the
  next `c.modal(...)` resolves with (default `async () => null`, i.e. closed). To simulate a submit:
  ```ts
  fake.modalResult = async () => ({ values: { hours: "12" }, ack: fake.modalSubmit(OWNER.id) });
  ```

See `src/modules/biomehunt/views/quota-delete.view.test.ts` for a full example covering a typed
retry loop, idle expiry, another user's input being ignored, and a `start`-driven immediate `done`.
