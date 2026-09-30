import { ContainerBuilder, MessageFlags, SeparatorSpacingSize, SlashCommandBuilder } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { type CommandContext, defineCommand, defineView, paginate, type ReplyOptions, type ViewDefinition } from "@/define";
import { CommandCategory } from "@/types";
import { EmbedFormatter } from "@/utils/format";
import { loadTestCases, resolveTestPages, type TestPayload } from "../registry";

/** Prefix "ephemeral" = deleted after this, not the default TTL: the countdown doesn't reset on
 * clicks, and a preview is often paged/picked through for a while. */
const REPLY_OPTS: ReplyOptions = { ephemeral: true, ttlMs: 5 * 60_000 };

function addDivider(container: ContainerBuilder): void {
    container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
}

function buildListPayload(): TestPayload {
    const cases = loadTestCases();
    const container = new ContainerBuilder().setAccentColor(0x5865f2);
    container.addTextDisplayComponents((td) => td.setContent("## 🧪 Test Previews"));

    if (cases.size === 0) {
        addDivider(container);
        container.addTextDisplayComponents((td) =>
            td.setContent("No test cases registered yet - add one under `src/modules/tests/tests/`."),
        );
        return { flags: MessageFlags.IsComponentsV2, components: [container] };
    }

    // Grouped by the keyword's first path segment (`embed/session-end` -> "embed") - purely
    // cosmetic today, but keeps this readable once there are more than a handful of tests.
    const groups = new Map<string, string[]>();
    for (const [key, tc] of [...cases.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const group = key.includes("/") ? key.slice(0, key.indexOf("/")) : "other";
        const lines = groups.get(group) ?? [];
        lines.push(`\`${key}\` - ${tc.description}`);
        groups.set(group, lines);
    }
    for (const [group, lines] of groups) {
        addDivider(container);
        container.addTextDisplayComponents((td) => td.setContent(`**${group}**\n${lines.join("\n")}`));
    }

    addDivider(container);
    container.addTextDisplayComponents((td) =>
        td.setContent("-# Run `!test <keyword>` directly, or just `!test` for an interactive picker."),
    );

    return { flags: MessageFlags.IsComponentsV2, components: [container] };
}

/** Opens `pages` on `ctx`: a single page is just a reply (no navigation needed), several pages
 * open as a `paginate` View. */
async function openTestPages(ctx: CommandContext, pages: TestPayload[]): Promise<void> {
    if (pages.length <= 1) {
        await ctx.reply(pages[0], REPLY_OPTS);
        return;
    }
    await ctx.open(paginate({ name: "tests.pages", pages: pages.length, renderPage: (page) => pages[page] }), undefined, REPLY_OPTS);
}

async function runTestCase(ctx: CommandContext, key: string, client: BotClient): Promise<void> {
    const testCase = loadTestCases().get(key);
    if (!testCase) {
        await ctx.reply(
            EmbedFormatter.error(`No test case \`${key}\`. Run \`!test\` for a picker, or \`!test list\` to see all.`),
            REPLY_OPTS,
        );
        return;
    }

    if (testCase.view) {
        await ctx.open(testCase.view(client), undefined, REPLY_OPTS);
        return;
    }

    let pages: TestPayload[];
    try {
        pages = await resolveTestPages(testCase, client);
    } catch (err) {
        await ctx.reply(EmbedFormatter.error(`Test \`${key}\` threw: ${err instanceof Error ? err.message : String(err)}`), REPLY_OPTS);
        return;
    }
    if (pages.length === 0) {
        await ctx.reply(EmbedFormatter.error(`Test \`${key}\` returned no pages.`), REPLY_OPTS);
        return;
    }

    await openTestPages(ctx, pages);
}

// ─── Picker ─────────────────────────────────────────────────────────────────

/** One dropdown entry - computed once upfront (`runPicker`) so `render` stays pure (no re-requiring
 * every test module on each render, or again on expiry). */
export interface PickerOption {
    key: string;
    description?: string;
}

type PickerState = { screen: "pick"; options: PickerOption[] } | { screen: "shown"; payload: TestPayload };

/** `!test` with no keyword: a select menu instead of a wall of text - pick one, it runs right
 * there (a single page replaces the picker in place; several pages open as a child `paginate`
 * View, sharing this session's clock). */
export function pickerView(client: BotClient): ViewDefinition<PickerState, void, PickerOption[]> {
    return defineView<PickerState, void, PickerOption[]>({
        name: "tests.picker",
        initial: (options) => ({ screen: "pick", options }),
        render: (state, kit) => {
            if (state.screen === "shown") return state.payload;

            const container = new ContainerBuilder().setAccentColor(0x5865f2);
            container.addTextDisplayComponents((td) => td.setContent("## 🧪 Test Previews"));
            container.addTextDisplayComponents((td) => td.setContent("-# Pick one from the dropdown to run it."));
            const select = kit.stringSelect("pick", (s) =>
                s
                    .setPlaceholder(`Choose a test to preview (${state.options.length} available)...`)
                    .addOptions(state.options.slice(0, 25).map((o) => ({ label: o.key, value: o.key, description: o.description }))),
            );
            return { flags: MessageFlags.IsComponentsV2, components: [container, kit.row(select)] };
        },
        on: {
            pick: async (c) => {
                const key = c.values[0];
                const testCase = loadTestCases().get(key);
                if (!testCase) return { screen: "shown", payload: EmbedFormatter.error(`Test \`${key}\` isn't registered anymore.`) };
                if (testCase.view) {
                    c.state = { screen: "shown", payload: EmbedFormatter.info(`Opened \`${key}\`.`) };
                    await c.open(testCase.view(client), undefined);
                    return;
                }

                let pages: TestPayload[];
                try {
                    pages = await resolveTestPages(testCase, client);
                } catch (err) {
                    return {
                        screen: "shown",
                        payload: EmbedFormatter.error(`Test \`${key}\` threw: ${err instanceof Error ? err.message : String(err)}`),
                    };
                }
                if (pages.length === 0) return { screen: "shown", payload: EmbedFormatter.error(`Test \`${key}\` returned no pages.`) };
                if (pages.length === 1) return { screen: "shown", payload: pages[0] };

                // Several pages: best-effort snapshot (page 1) so `onExpire` has real content to
                // fall back on if the session expires while the child below is open - `onExpire`
                // only shows the "Picker timed out" text for a truly untouched "pick" screen.
                c.state = { screen: "shown", payload: pages[0] };
                // Hand the message to a child `paginate` View - it never `done()`s on its own, so
                // this simply parks here (sharing the root's idle clock) until expiry.
                await c.open(paginate({ name: "tests.pages", pages: pages.length, renderPage: (page) => pages[page] }), undefined);
            },
        },
        // Only an untouched picker gets the old warning text; after any pick (single page shown
        // directly, or the best-effort snapshot above for a multi-page one) it's just static
        // content already, nothing interactive left to strip.
        onExpire: (state) => (state.screen === "pick" ? EmbedFormatter.warn("Picker timed out - nothing selected.") : state.payload),
    });
}

async function runPicker(ctx: CommandContext, client: BotClient): Promise<void> {
    const cases = loadTestCases();
    if (cases.size === 0) {
        await ctx.reply(EmbedFormatter.info("No test cases registered yet - add one under `src/modules/tests/tests/`."), REPLY_OPTS);
        return;
    }
    const options: PickerOption[] = [...cases.keys()].sort().map((key) => ({
        key,
        description: (cases.get(key)?.description ?? "").slice(0, 100) || undefined,
    }));
    await ctx.open(pickerView(client), options, REPLY_OPTS);
}

export default defineCommand({
    name: "test",
    description: "Previews a hardcoded embed/container with fake data - no live data or DB writes involved.",
    category: CommandCategory.UTILITY,
    showOnHelp: false,
    botOwnerOnly: true,

    options: new SlashCommandBuilder().addStringOption((o) =>
        o.setName("keyword").setDescription('Test case to preview, or "list" to see all (e.g. embed/session-end)').setRequired(false),
    ),

    async run(ctx) {
        await ctx.defer({ ephemeral: true });
        const keyword = ctx.args.getString("keyword");

        if (!keyword) {
            await runPicker(ctx, ctx.client);
            return;
        }
        if (keyword === "list") {
            await ctx.reply(buildListPayload(), REPLY_OPTS);
            return;
        }
        await runTestCase(ctx, keyword, ctx.client);
    },
});
