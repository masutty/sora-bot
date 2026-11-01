import { expect, test } from "bun:test";
import { settings } from "../settings";
import type { Block, OptionRow, PanelRow } from "../types";
import { option, panel } from "../views/panel.fixtures";
import { exportPanel, findPanel, importPanelFile, parsePanelExport, type TransferStore, uniqueName } from "./panel-transfer";

const noCustom = () => false;

function fakeStore(panels: PanelRow[], options: OptionRow[]) {
    const created: Parameters<TransferStore["importPanel"]>[1][] = [];
    const store: TransferStore = {
        listPanels: async () => panels,
        listOptions: async (panelId) => options.filter((o) => o.panel_id === panelId),
        importPanel: async (guildId, input) => {
            created.push(input);
            return { id: 50, guild_id: guildId, channel_id: null, message_id: null, ...input } as PanelRow;
        },
    };
    return { store, created };
}

const valid = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
        format: "sora-panel",
        version: 1,
        exportedAt: "2026-11-01T00:00:00.000Z",
        panel: {
            name: "Rules",
            placeholder: "Pick",
            blocks: [{ t: "title", v: "Rules" }],
            options: [{ label: "Chat", emoji: "💬", description: null, blocks: [{ t: "text", v: "No spam." }] }],
            ...overrides,
        },
    });

test("export carries the pages, never ids, channel or message", async () => {
    const { store } = fakeStore([panel({ channel_id: "c1", message_id: "m1" })], [option(1, "Chat", { emoji: "💬" })]);
    const { file, fileName } = await exportPanel("g1", "7", store);
    expect(fileName).toBe("panel-server-rules.json");
    expect(file).toMatchObject({ format: "sora-panel", version: 1, panel: { name: "Server rules", placeholder: "Pick a category" } });
    expect(file.panel.options).toEqual([{ label: "Chat", emoji: "💬", description: null, blocks: [{ t: "title", v: "Chat" }] }]);
    const text = JSON.stringify(file);
    expect(text).not.toContain("c1");
    expect(text).not.toContain("m1");
    expect(text).not.toContain("guild_id");
});

test("a panel is found by id or by name, ignoring case", async () => {
    const { store } = fakeStore([panel()], []);
    expect((await findPanel("g1", "7", store)).id).toBe(7);
    expect((await findPanel("g1", " SERVER RULES ", store)).id).toBe(7);
    await expect(findPanel("g1", "nope", store)).rejects.toThrow("couldn't find");
});

test("what export writes, import reads back the same", async () => {
    const { store, created } = fakeStore([panel()], [option(1, "Chat", { emoji: "💬", description: "Text channels" }), option(2, "Voice")]);
    const { file } = await exportPanel("g1", "7", store);
    const { store: target, created: made } = fakeStore([], []);
    const result = await importPanelFile("g2", JSON.stringify(file), noCustom, target);
    expect(created).toHaveLength(0);
    expect(made).toHaveLength(1);
    expect(made[0]).toEqual({
        name: "Server rules",
        placeholder: "Pick a category",
        blocks: file.panel.blocks,
        options: file.panel.options,
    });
    expect(result).toMatchObject({ options: 2, droppedEmoji: 0 });
});

test("import always creates a new panel and renames it when the name is taken", async () => {
    const { store, created } = fakeStore([panel({ name: "Rules" }), panel({ id: 8, name: "rules (2)" })], []);
    await importPanelFile("g1", valid(), noCustom, store);
    expect(created[0].name).toBe("Rules (3)");
});

test("uniqueName keeps the name inside Discord's limit", () => {
    const long = "n".repeat(settings.maxPanelName);
    expect(uniqueName(long, [long]).length).toBeLessThanOrEqual(settings.maxPanelName);
    expect(uniqueName("Rules", [])).toBe("Rules");
});

test("a custom emoji from a server the bot is not in is dropped and counted, the rest imports", async () => {
    const text = valid({
        options: [
            { label: "A", emoji: "<:xx:123456789012345678>", description: null, blocks: [] },
            { label: "B", emoji: "<:yy:223456789012345678>", description: null, blocks: [] },
            { label: "C", emoji: "not an emoji", description: null, blocks: [] },
            { label: "D", emoji: "📜", description: null, blocks: [] },
        ],
    });
    const parsed = await parsePanelExport(text, (id) => id === "123456789012345678");
    expect(parsed.options.map((o) => o.emoji)).toEqual(["<:xx:123456789012345678>", null, null, "📜"]);
    expect(parsed.droppedEmoji).toBe(2);
});

test("a wrong file is refused with a reason, and nothing is created", async () => {
    const { store, created } = fakeStore([], []);
    const bad: [string, string][] = [
        ["{nope", "not valid JSON"],
        [JSON.stringify({ hello: 1 }), "not a panel export"],
        [JSON.stringify({ format: "sora-panel", version: 2, panel: {} }), "version 2"],
        [valid({ options: "x" }), '"options"'],
        [valid({ name: "" }), "name"],
        [valid({ blocks: [{ t: "video" }] }), "unknown type"],
        [valid({ blocks: [{ t: "img", url: "http://insecure.io/a.png" }] }), "https"],
        [valid({ blocks: [{ t: "text", v: "" }] }), "text"],
        [valid({ options: [{ label: "Chat", blocks: [{ t: "title", v: "" }] }] }), 'The page "Chat"'],
    ];
    for (const [text, reason] of bad) {
        await expect(importPanelFile("g1", text, noCustom, store)).rejects.toThrow(reason);
    }
    expect(created).toHaveLength(0);
});

test("the editor's limits hold for imported files too", async () => {
    const { store } = fakeStore([], []);
    const sep: Block = { t: "sep" };
    await expect(
        importPanelFile("g1", valid({ blocks: Array.from({ length: settings.maxBlocks + 1 }, () => sep) }), noCustom, store),
    ).rejects.toThrow("blocks");
    const options = Array.from({ length: settings.maxOptions + 1 }, (_, i) => ({ label: `O${i}`, blocks: [] }));
    await expect(importPanelFile("g1", valid({ options }), noCustom, store)).rejects.toThrow(`${settings.maxOptions} options`);
    const images = Array.from({ length: settings.maxImages + 1 }, () => ({ t: "img", url: "https://a.io/x.png" }));
    await expect(importPanelFile("g1", valid({ blocks: images }), noCustom, store)).rejects.toThrow("images");
});

test("a server at its panel limit cannot import another", async () => {
    const full = Array.from({ length: settings.maxPanelsPerGuild }, (_, i) => panel({ id: i + 1, name: `M${i}` }));
    const { store, created } = fakeStore(full, []);
    await expect(importPanelFile("g1", valid(), noCustom, store)).rejects.toThrow("panels");
    expect(created).toHaveLength(0);
});
