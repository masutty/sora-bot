# Creating a cog

A tutorial for a complete cog: **suggestions**. A member sends `/suggest new`, the bot posts the suggestion with a 👍 button that keeps working after a restart, `/suggest list` shows the most voted ones in pages, and a worker deletes old ones.

Along the way it uses every piece of the framework:

| Piece | Where it shows up |
|---|---|
| `defineCog` | [`index.ts`](#7-indexts-wiring-it-all-together) |
| Migrations | [`migrations.ts`](#1-migrationsts) |
| Repository | [`repository/`](#2-repository) |
| `defineCommand` + subcommands | [`commands/`](#4-the-command) |
| Ready-made View (`paginate`) | [`/suggest list`](#4-the-command) |
| `defineComponent` (persistent button) | [`components/`](#5-the-persistent-button) |
| `defineWorker` | [`workers/`](#6-the-worker) |
| Tests | [`views/*.test.ts`](#8-testing) |

> [!NOTE]
> This guide shows the *path*. The reference for each API (every command option, views, modals, `flow`, `tabs`, `confirm`) is in [`src/core/README.md`](../src/core/README.md).

## Final layout

```
src/usermodules/suggestions/
├── index.ts                          # defineCog(...)
├── migrations.ts
├── settings.ts
├── commands/suggest.command.ts
├── components/upvote.component.ts
├── repository/suggestions.repository.ts
├── views/suggestion.view.ts          # pure message builders
├── views/suggestion.view.test.ts
└── workers/cleanup.worker.ts
```

> [!IMPORTANT]
> Only `index.ts`, `types.ts`, `settings.ts` and `migrations.ts` sit loose at the root. Everything else goes in a folder, with that folder's suffix in the filename (`*.command.ts`, `*.view.ts`, ...). And a module imports the framework **only** from `@/define`, never from `@/core/*`.

## 1. `migrations.ts`

```ts
export const SUGGESTIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS sg_suggestions (
    id          SERIAL       PRIMARY KEY,
    guild_id    VARCHAR(20)  NOT NULL,
    author_id   VARCHAR(20)  NOT NULL,
    content     TEXT         NOT NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sg_votes (
    suggestion_id INT         NOT NULL REFERENCES sg_suggestions(id) ON DELETE CASCADE,
    user_id       VARCHAR(20) NOT NULL,
    PRIMARY KEY (suggestion_id, user_id)
);
`;
```

The loader runs this when the cog loads and stores a hash in `_migrations`.

> [!WARNING]
> **If the SQL changes, the whole block runs again.** Always write it idempotently: `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`. An `ALTER TABLE ... ADD COLUMN` without `IF NOT EXISTS` breaks the boot on the second run.

> [!TIP]
> Prefix your tables with a short cog tag (`sg_`, `bh_`). All cogs share the same database.

## 2. Repository

Database access only: rows in, rows out. No discord.js types here.

```ts
// repository/suggestions.repository.ts
import { query } from "@/database/connection";

export interface SuggestionRow {
    id: number;
    author_id: string;
    content: string;
    votes: number;
}

export async function createSuggestion(guildId: string, authorId: string, content: string): Promise<number> {
    const { rows } = await query<{ id: number }>(
        `INSERT INTO sg_suggestions (guild_id, author_id, content) VALUES ($1, $2, $3) RETURNING id`,
        [guildId, authorId, content],
    );
    return rows[0].id;
}

/** Toggles the vote. Returns the new vote count. */
export async function toggleVote(suggestionId: number, userId: string): Promise<number> {
    const removed = await query(`DELETE FROM sg_votes WHERE suggestion_id = $1 AND user_id = $2`, [suggestionId, userId]);
    if (!removed.rowCount) {
        await query(`INSERT INTO sg_votes (suggestion_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [suggestionId, userId]);
    }
    const { rows } = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM sg_votes WHERE suggestion_id = $1`, [suggestionId]);
    return rows[0].n;
}

export async function topSuggestions(guildId: string): Promise<SuggestionRow[]> {
    const { rows } = await query<SuggestionRow>(
        `SELECT s.id, s.author_id, s.content, COUNT(v.user_id)::int AS votes
           FROM sg_suggestions s
           LEFT JOIN sg_votes v ON v.suggestion_id = s.id
          WHERE s.guild_id = $1
          GROUP BY s.id
          ORDER BY votes DESC, s.id DESC`,
        [guildId],
    );
    return rows;
}

export async function deleteOlderThan(days: number): Promise<number> {
    const { rowCount } = await query(`DELETE FROM sg_suggestions WHERE created_at < NOW() - make_interval(days => $1)`, [days]);
    return rowCount ?? 0;
}
```

> [!TIP]
> Need several queries to be atomic? Use `transaction(async (client) => { ... })` from `@/database/connection`: any error rolls back.

## 3. Message builders

Pure functions, no I/O. They're easy to test and can be shared by the command and the button.

```ts
// views/suggestion.view.ts
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { NO_PINGS } from "@/utils/format";

export const UPVOTE_PREFIX = "suggestions:upvote";

export function buildSuggestionMessage(id: number, authorId: string, content: string, votes: number) {
    return {
        content: `💡 **Suggestion #${id}** by <@${authorId}>\n${content}`,
        components: [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId(`${UPVOTE_PREFIX}:${id}`).setLabel(`👍 ${votes}`).setStyle(ButtonStyle.Secondary),
            ),
        ],
        allowedMentions: NO_PINGS,
    };
}
```

## 4. The command

A single `run(ctx)` handles both `/suggest new text:...` and `!suggest new ...`.

```ts
// commands/suggest.command.ts
import { SlashCommandBuilder } from "discord.js";
import { defineCommand, paginate, UserFacingError } from "@/define";
import { CommandCategory } from "@/types";
import { createSuggestion, topSuggestions } from "../repository/suggestions.repository";
import { settings } from "../settings";
import { buildSuggestionMessage } from "../views/suggestion.view";

export default defineCommand({
    name: "suggest",
    description: "Server suggestions.",
    category: CommandCategory.GENERAL,
    guildOnly: true, // ctx.guild and ctx.member are never null

    options: new SlashCommandBuilder()
        .addSubcommand((s) =>
            s
                .setName("new")
                .setDescription("Submit a suggestion.")
                .addStringOption((o) => o.setName("text").setDescription("Your suggestion").setRequired(true)),
        )
        .addSubcommand((s) => s.setName("list").setDescription("Most voted suggestions.")),

    async run(ctx) {
        switch (ctx.args.getSubcommand()) {
            case "new": {
                const text = ctx.args.getString("text", true); // `true`: missing becomes an error, never null
                if (text.length > settings.maxLength) {
                    throw new UserFacingError(`A suggestion can be at most ${settings.maxLength} characters.`);
                }
                const id = await createSuggestion(ctx.guild.id, ctx.user.id, text);
                await ctx.reply(buildSuggestionMessage(id, ctx.user.id, text, 0));
                return;
            }
            case "list": {
                const rows = await topSuggestions(ctx.guild.id);
                if (!rows.length) {
                    await ctx.reply("No suggestions yet.");
                    return;
                }
                const perPage = 5;
                await ctx.open(
                    paginate({
                        name: "suggestions.list",
                        pages: Math.ceil(rows.length / perPage),
                        renderPage: (page) => ({
                            content: rows
                                .slice(page * perPage, (page + 1) * perPage)
                                .map((r) => `**#${r.id}** · 👍 ${r.votes} · ${r.content}`)
                                .join("\n"),
                        }),
                    }),
                    undefined,
                    { ephemeral: true },
                );
            }
        }
    },
});
```

What the framework already does for you, before `run`:

- `!suggest` without a subcommand replies with the usage generated from the builder.
- `guildOnly` refuses DM calls.
- A missing required argument becomes a clear error for the user.

> [!TIP]
> `UserFacingError` is for **expected** errors (bad input, missing config): its message is shown to the user as is. Any other error is logged and the user gets a generic message with the `ref` so you can find it in the logs.

> [!NOTE]
> On prefix, arguments are positional (the last one takes the rest of the line) or named: `!suggest new text:"more voice channels"`.

## 5. The persistent button

The suggestion's button has to keep working forever, even after a restart. A View won't do (it lives in memory and expires), so the button is a **persistent component**, and its state lives in the database.

```ts
// components/upvote.component.ts
import { ActionRowBuilder, ButtonBuilder } from "discord.js";
import { defineComponent } from "@/define";
import { toggleVote } from "../repository/suggestions.repository";
import { UPVOTE_PREFIX } from "../views/suggestion.view";

export function upvoteComponent() {
    return defineComponent({
        prefix: UPVOTE_PREFIX, // "suggestions:upvote" - must start with "<cog name>:"
        handle: async (interaction, parts) => {
            if (!interaction.isButton()) return;
            const id = Number(parts[0]); // customId "suggestions:upvote:42" -> parts = ["42"]
            if (!Number.isInteger(id)) return;

            const votes = await toggleVote(id, interaction.user.id);
            const button = ButtonBuilder.from(interaction.component).setLabel(`👍 ${votes}`);
            await interaction.update({ components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)] });
        },
    });
}
```

> [!CAUTION]
> The `prefix` **must** start with the cog's `name` followed by `:`. Otherwise the cog fails to load. That's on purpose: a wrong prefix would never receive a single click, and the mistake would go unnoticed.

## 6. The worker

```ts
// settings.ts
export const settings = {
    maxLength: 500,
    retentionDays: 30,
    workers: {
        cleanupTickMs: 60 * 60 * 1000, // 1h
    },
} as const;
```

```ts
// workers/cleanup.worker.ts
import { defineWorker } from "@/define";
import { Logger } from "@/utils/logging";
import { deleteOlderThan } from "../repository/suggestions.repository";
import { settings } from "../settings";

const logger = new Logger("suggestions.cleanup");

export const cleanupWorker = defineWorker({
    name: "cleanup",
    intervalMs: settings.workers.cleanupTickMs,
    runOnStart: true,
    run: async () => {
        const n = await deleteOlderThan(settings.retentionDays);
        if (n) logger.info(`Deleted ${n} old suggestion(s).`);
    },
});
```

The framework owns the loop: it starts after `onReady`, stops on reload, never runs two ticks at once, and an error in one tick doesn't kill the loop.

## 7. `index.ts`: wiring it all together

```ts
import { defineCog } from "@/define";
import _suggest from "./commands/suggest.command";
import { upvoteComponent } from "./components/upvote.component";
import { SUGGESTIONS_SCHEMA } from "./migrations";
import { cleanupWorker } from "./workers/cleanup.worker";

export default defineCog({
    name: "suggestions",
    description: "Suggestions with voting.",
    authors: [{ name: "you", id: 0n }],

    commands: [_suggest],
    migrations: [SUGGESTIONS_SCHEMA],
    components: [upvoteComponent()],
    workers: [cleanupWorker],

    // Optional:
    // events: { async messageCreate(client, message) { ... } },
    // async onReady(client) { ... },   // runs before the workers start
    // async start(client) { ... },
    // async stop(client) { ... },
});
```

Done. Restart the bot or run `!bot reload`.

```bash
bun run check:commands   # validates names and builders without starting the bot
```

## 8. Testing

Pure builders are tested directly:

```ts
// views/suggestion.view.test.ts
import { expect, test } from "bun:test";
import { buildSuggestionMessage } from "./suggestion.view";

test("button carries the suggestion id and the vote count", () => {
    const msg = buildSuggestionMessage(42, "111", "More voice channels", 3);
    const button = msg.components[0].components[0].toJSON();
    expect(button).toMatchObject({ custom_id: "suggestions:upvote:42", label: "👍 3" });
});

test("never pings the author", () => {
    expect(buildSuggestionMessage(1, "111", "x", 0).allowedMentions).toEqual({ parse: [] });
});
```

```bash
bun test src/usermodules/suggestions
```

> [!TIP]
> For interactive Views (clicks, modals, expiry), use `createFakeViewTransport` from `@/define`. A full example is in [`src/core/README.md` §9](../src/core/README.md#9-testing-a-view-the-fake-transport).

## Checklist

- [ ] Cog `name` unique across `modules/` and `usermodules/`
- [ ] Tables prefixed with the cog tag, SQL idempotent
- [ ] Framework imports only from `@/define`
- [ ] Component prefixes start with `<cog>:`
- [ ] View names in the `<cog>.<name>` format
- [ ] `bun run check:commands`, `bun test` and `bun run lint` passing

## Disabling or removing

- **Disable without touching code:** add the folder name to `DISABLED_COG_DIRS` and restart.
- **Unload at runtime:** `/bot mod unload name:suggestions`.
- **Remove for good:** delete the folder. The tables stay in the database until you drop them.
