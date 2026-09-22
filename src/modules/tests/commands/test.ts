import {
    ActionRowBuilder, ComponentType, ContainerBuilder, MessageFlags, SeparatorSpacingSize,
    SlashCommandBuilder, StringSelectMenuBuilder,
} from "discord.js";
import type { Message } from "discord.js";
import type { BotClient } from "@/core/BotClient";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import { EmbedFormatter } from "@/utils/format";
import { attachPagination, buildPaginationRow } from "@/utils/pagination";
import { loadTestCases, resolveTestPages, type TestPayload } from "../registry";

const PICKER_SELECT_ID = "test-picker-select";
const PICKER_TIMEOUT_MS = 60_000;

function addDivider(container: ContainerBuilder): void {
    container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
}

function buildListPayload(): TestPayload {
    const cases = loadTestCases();
    const container = new ContainerBuilder().setAccentColor(0x5865f2);
    container.addTextDisplayComponents((td) => td.setContent("## 🧪 Test Previews"));

    if (cases.size === 0) {
        addDivider(container);
        container.addTextDisplayComponents((td) => td.setContent("No test cases registered yet - add one under `src/modules/tests/tests/`."));
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
    container.addTextDisplayComponents((td) => td.setContent("-# Run `!test <keyword>` directly, or just `!test` for an interactive picker."));

    return { flags: MessageFlags.IsComponentsV2, components: [container] };
}

/** Wraps a test case's raw pages into a `render(page, interactive)` - dropping the nav row once
 * the collector expires, same convention `attachPagination` expects everywhere else it's used. */
function buildPagedRender(pages: TestPayload[]): (page: number, interactive: boolean) => TestPayload {
    return (page, interactive) => ({
        ...pages[page],
        components: [
            ...(pages[page].components ?? []),
            ...(interactive && pages.length > 1 ? [buildPaginationRow(page, pages.length)] : []),
        ],
    });
}

async function runTestCase(
    key: string,
    client: BotClient,
    invokerId: string,
    send: (payload: TestPayload) => Promise<Message>,
): Promise<void> {
    const testCase = loadTestCases().get(key);
    if (!testCase) {
        await send(EmbedFormatter.error(`No test case \`${key}\`. Run \`!test\` for a picker, or \`!test list\` to see all.`));
        return;
    }

    let pages: TestPayload[];
    try {
        pages = await resolveTestPages(testCase, client);
    } catch (err) {
        await send(EmbedFormatter.error(`Test \`${key}\` threw: ${err instanceof Error ? err.message : String(err)}`));
        return;
    }
    if (pages.length === 0) {
        await send(EmbedFormatter.error(`Test \`${key}\` returned no pages.`));
        return;
    }

    const render = buildPagedRender(pages);
    const msg = await send(render(0, true));
    if (pages.length > 1) attachPagination(msg, { invokerId, pages: pages.length, render });
}

function buildPickerRow(keys: string[]): ActionRowBuilder<StringSelectMenuBuilder> {
    const cases = loadTestCases();
    const menu = new StringSelectMenuBuilder()
        .setCustomId(PICKER_SELECT_ID)
        .setPlaceholder(`Choose a test to preview (${keys.length} available)...`)
        .addOptions(
            keys.slice(0, 25).map((key) => ({
                label: key,
                value: key,
                description: (cases.get(key)?.description ?? "").slice(0, 100) || undefined,
            })),
        );
    return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

/** `!test` with no keyword: a select menu instead of a wall of text - pick one, it runs right there. */
async function runPicker(client: BotClient, invokerId: string, send: (payload: TestPayload) => Promise<Message>): Promise<void> {
    const cases = loadTestCases();
    if (cases.size === 0) {
        await send(EmbedFormatter.info("No test cases registered yet - add one under `src/modules/tests/tests/`."));
        return;
    }

    const keys = [...cases.keys()].sort();
    const container = new ContainerBuilder().setAccentColor(0x5865f2);
    container.addTextDisplayComponents((td) => td.setContent("## 🧪 Test Previews"));
    container.addTextDisplayComponents((td) => td.setContent("-# Pick one from the dropdown to run it."));

    // `TestPayload` only types its action row as ActionRowBuilder<ButtonBuilder> (the shape every
    // other test payload needs) - a select menu row is equally valid at runtime, just outside that
    // narrower type, so it's cast here rather than widening the type everyone else uses.
    const msg = await send({ flags: MessageFlags.IsComponentsV2, components: [container, buildPickerRow(keys)] } as TestPayload);

    const collector = msg.createMessageComponentCollector({ componentType: ComponentType.StringSelect, idle: PICKER_TIMEOUT_MS, max: 1 });

    collector.on("collect", async (i) => {
        if (i.user.id !== invokerId) {
            await i.reply({ content: "That picker isn't yours!", ephemeral: true }).catch(() => { });
            return;
        }

        const key = i.values[0];
        const testCase = loadTestCases().get(key);
        if (!testCase) {
            await i.update(EmbedFormatter.error(`Test \`${key}\` isn't registered anymore.`)).catch(() => { });
            return;
        }

        try {
            const pages = await resolveTestPages(testCase, client);
            if (pages.length === 0) {
                await i.update(EmbedFormatter.error(`Test \`${key}\` returned no pages.`)).catch(() => { });
                return;
            }
            const render = buildPagedRender(pages);
            await i.update(render(0, true));
            if (pages.length > 1) attachPagination(msg, { invokerId, pages: pages.length, render });
        } catch (err) {
            await i.update(EmbedFormatter.error(`Test \`${key}\` threw: ${err instanceof Error ? err.message : String(err)}`)).catch(() => { });
        }
    });

    collector.on("end", (collected) => {
        if (collected.size === 0) msg.edit(EmbedFormatter.warn("Picker timed out - nothing selected.")).catch(() => { });
    });
}

async function runKeyword(
    keyword: string | null,
    invokerId: string,
    client: BotClient,
    send: (payload: TestPayload) => Promise<Message>,
): Promise<void> {
    if (!keyword) return runPicker(client, invokerId, send);
    if (keyword === "list") {
        await send(buildListPayload());
        return;
    }
    return runTestCase(keyword, client, invokerId, send);
}

export default defineCommand({
    name: "test",
    description: "Previews a hardcoded embed/container with fake data - no live data or DB writes involved.",
    category: CommandCategory.UTILITY,
    showOnHelp: false,
    botOwnerOnly: true,

    options: new SlashCommandBuilder()
        .addStringOption((o) =>
            o.setName("keyword").setDescription("Test case to preview, or \"list\" to see all (e.g. embed/session-end)").setRequired(false),
        ),

    async executeAsSlash(interaction, client) {
        await interaction.deferReply({ ephemeral: true });
        await runKeyword(interaction.options.getString("keyword"), interaction.user.id, client, (payload) => interaction.editReply(payload));
    },

    async executeAsPrefix(message, args, client) {
        await runKeyword(args.getString("keyword"), message.author.id, client, (payload) => message.reply(payload));
    },
});
