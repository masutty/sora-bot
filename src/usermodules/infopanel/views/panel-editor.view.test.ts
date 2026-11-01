import { expect, test } from "bun:test";
import { createFakeViewTransport, type ViewPayload } from "@/define";
import type { PanelService } from "../services/panel.service";
import { settings } from "../settings";
import type { Block, OptionRow, PanelRow } from "../types";
import { type EditorDeps, panelEditorView } from "./panel-editor.view";

const OWNER = "owner";

/** Every node of the message as plain JSON, depth-first. */
function nodes(payload: ViewPayload): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    const walk = (node: unknown) => {
        if (node === null || typeof node !== "object") return;
        const json = typeof (node as { toJSON?: unknown }).toJSON === "function" ? (node as { toJSON(): unknown }).toJSON() : node;
        if (Array.isArray(json)) {
            for (const child of json) walk(child);
            return;
        }
        const obj = json as Record<string, unknown>;
        if (typeof obj.type === "number") out.push(obj);
        walk(obj.components);
        walk(obj.accessory);
        walk(obj.items);
    };
    walk(payload.components);
    return out;
}

const text = (payload: ViewPayload) =>
    nodes(payload)
        .map((n) => (typeof n.content === "string" ? n.content : ""))
        .join("\n");

const has = (payload: ViewPayload, key: string) =>
    nodes(payload).some((n) => typeof n.custom_id === "string" && n.custom_id.endsWith(`:${key}`));

function setup(seed?: { panels?: PanelRow[]; options?: OptionRow[] }) {
    let nextId = 100;
    const state = { panels: seed?.panels ?? [], options: seed?.options ?? [] };
    const log: string[] = [];
    const service: PanelService = {
        refresh: async (id) => void log.push(`refresh ${id}`),
        publish: async (id, channel) => void log.push(`publish ${id} ${channel}`),
        remove: async (id) => {
            log.push(`remove ${id}`);
            state.panels = state.panels.filter((m) => m.id !== id);
        },
    };
    const deps: EditorDeps = {
        guildId: "g1",
        listPanels: async () => state.panels,
        insertPanel: async (guildId, name, placeholder, blocks) => {
            const row: PanelRow = { id: nextId++, guild_id: guildId, name, placeholder, blocks, channel_id: null, message_id: null };
            state.panels = [...state.panels, row];
            return row;
        },
        updatePanel: async (id, patch) => {
            state.panels = state.panels.map((m) => (m.id === id ? { ...m, ...patch } : m));
        },
        listOptions: async (panelId) => state.options.filter((o) => o.panel_id === panelId),
        insertOption: async (panelId, fields, blocks) => {
            const row: OptionRow = { id: nextId++, panel_id: panelId, position: state.options.length, ...fields, blocks };
            state.options = [...state.options, row];
            return row;
        },
        updateOption: async (id, patch) => {
            state.options = state.options.map((o) => (o.id === id ? { ...o, ...patch } : o));
        },
        deleteOption: async (id) => {
            state.options = state.options.filter((o) => o.id !== id);
        },
        moveOption: async () => {},
        hasCustomEmoji: async (id) => id === "123456789012345678",
        findCustomEmoji: async (name) => (name === "tragedy" ? "<:tragedy:123456789012345678>" : null),
        service,
    };
    const fake = createFakeViewTransport();
    const modal = (values: Record<string, string>) => {
        fake.modalResult = async () => ({ values, ack: fake.modalSubmit(OWNER) });
    };
    return { deps, state, log, fake, modal };
}

const row = (id: number, blocks: Block[] = [{ t: "title", v: "Rules" }]): PanelRow => ({
    id,
    guild_id: "g1",
    name: `Panel ${id}`,
    placeholder: "Pick one",
    blocks,
    channel_id: null,
    message_id: null,
});

const opt = (id: number, panelId: number, label: string, blocks: Block[] = [{ t: "title", v: label }]): OptionRow => ({
    id,
    panel_id: panelId,
    position: id,
    label,
    emoji: null,
    description: null,
    blocks,
});

test("an empty server starts on the panels list; Add panel creates one and opens its page", async () => {
    const { deps, state, fake, modal } = setup();
    void fake.run(panelEditorView(deps), undefined, OWNER);
    await fake.flush();
    expect(text(fake.lastPayload())).toContain("No panels yet.");

    modal({ name: "Server rules" });
    await fake.emit(fake.click("addPanel", OWNER));
    expect(state.panels).toHaveLength(1);
    expect(state.panels[0]).toMatchObject({ name: "Server rules", blocks: [{ t: "title", v: "Server rules" }] });
    expect(has(fake.lastPayload(), "blockEdit") || has(fake.lastPayload(), "addTitle")).toBe(true);
    expect(text(fake.lastPayload())).toContain("## Server rules");
});

test("Add option appends a page, opens it, and refreshes the posted message", async () => {
    const { deps, state, log, fake, modal } = setup({ panels: [row(1)] });
    void fake.run(panelEditorView(deps), undefined, OWNER);
    await fake.flush();
    await fake.emit(fake.click("open:0", OWNER));
    await fake.emit(fake.click("options", OWNER));

    modal({ label: "General rules", emoji: "📜", description: "" });
    await fake.emit(fake.click("addOption", OWNER));
    expect(state.options).toHaveLength(1);
    expect(state.options[0]).toMatchObject({ label: "General rules", emoji: "📜", description: null });
    expect(log).toContain("refresh 1");
    expect(has(fake.lastPayload(), "optionUp")).toBe(true);
});

test("a bad emoji is told to the admin and nothing is saved", async () => {
    const { deps, state, fake, modal } = setup({ panels: [row(1)] });
    void fake.run(panelEditorView(deps), undefined, OWNER);
    await fake.flush();
    await fake.emit(fake.click("open:0", OWNER));
    await fake.emit(fake.click("options", OWNER));

    modal({ label: "General", emoji: "nope", description: "" });
    await fake.emit(fake.click("addOption", OWNER));
    expect(state.options).toHaveLength(0);
    expect(fake.notifies.at(-1)?.content).toContain("not a single emoji");
});

test("editing the root's blocks saves them and refreshes the posted panel; an option's page does not", async () => {
    const { deps, state, log, fake, modal } = setup({ panels: [row(1)], options: [opt(10, 1, "Chat")] });
    void fake.run(panelEditorView(deps), undefined, OWNER);
    await fake.flush();
    await fake.emit(fake.click("open:0", OWNER));

    modal({ v: "Read them." });
    await fake.emit(fake.click("addText", OWNER));
    expect(state.panels[0].blocks).toEqual([
        { t: "title", v: "Rules" },
        { t: "text", v: "Read them." },
    ]);
    expect(log).toEqual(["refresh 1"]);

    await fake.emit(fake.click("target", OWNER, ["10"]));
    modal({ v: "No spam." });
    await fake.emit(fake.click("addText", OWNER));
    expect(state.options[0].blocks).toHaveLength(2);
    expect(log).toEqual(["refresh 1"]);
});

test("blocks move, edit and remove by index", async () => {
    const blocks: Block[] = [{ t: "title", v: "A" }, { t: "text", v: "B" }, { t: "sep" }];
    const { deps, state, fake, modal } = setup({ panels: [row(1, blocks)] });
    void fake.run(panelEditorView(deps), undefined, OWNER);
    await fake.flush();
    await fake.emit(fake.click("open:0", OWNER));

    await fake.emit(fake.click("block", OWNER, ["1"]));
    await fake.emit(fake.click("blockUp", OWNER));
    expect(state.panels[0].blocks.map((b) => b.t)).toEqual(["text", "title", "sep"]);

    modal({ v: "B2" });
    await fake.emit(fake.click("blockEdit", OWNER));
    expect(state.panels[0].blocks[0]).toEqual({ t: "text", v: "B2" });

    await fake.emit(fake.click("blockRemove", OWNER));
    expect(state.panels[0].blocks.map((b) => b.t)).toEqual(["title", "sep"]);
});

test("the page limits are told to the admin instead of saved", async () => {
    const full = Array.from({ length: settings.maxBlocks }, (): Block => ({ t: "sep" }));
    const { deps, state, fake } = setup({ panels: [row(1, full)] });
    void fake.run(panelEditorView(deps), undefined, OWNER);
    await fake.flush();
    await fake.emit(fake.click("open:0", OWNER));
    const addSep = nodes(fake.lastPayload()).find((n) => String(n.custom_id).endsWith(":addSep"));
    expect(addSep?.disabled).toBe(true);
    expect(state.panels[0].blocks).toHaveLength(settings.maxBlocks);
});

test("Publish needs a channel, then posts through the service", async () => {
    const { deps, log, fake } = setup({ panels: [row(1)], options: [opt(10, 1, "Chat")] });
    void fake.run(panelEditorView(deps), undefined, OWNER);
    await fake.flush();
    await fake.emit(fake.click("open:0", OWNER));
    await fake.emit(fake.click("publish", OWNER));
    expect(nodes(fake.lastPayload()).find((n) => String(n.custom_id).endsWith(":post"))?.disabled).toBe(true);

    await fake.emit(fake.click("channel", OWNER, ["c9"]));
    await fake.emit(fake.click("post", OWNER));
    expect(log).toContain("publish 1 c9");
});

test("Delete panel asks first, then removes the panel and returns to the list", async () => {
    const { deps, state, log, fake } = setup({ panels: [row(1)] });
    void fake.run(panelEditorView(deps), undefined, OWNER);
    await fake.flush();
    await fake.emit(fake.click("open:0", OWNER));
    await fake.emit(fake.click("deletePanel", OWNER));
    expect(text(fake.lastPayload())).toContain("Delete this panel?");
    expect(state.panels).toHaveLength(1);

    await fake.emit(fake.click("yes", OWNER));
    expect(log).toContain("remove 1");
    expect(text(fake.lastPayload())).toContain("No panels yet.");
});

test("a custom emoji from a server the bot is not in is refused", async () => {
    const { deps, state, fake, modal } = setup({ panels: [row(1)] });
    void fake.run(panelEditorView(deps), undefined, OWNER);
    await fake.flush();
    await fake.emit(fake.click("open:0", OWNER));
    await fake.emit(fake.click("options", OWNER));

    modal({ label: "General", emoji: "<:rules:999999999999999999>", description: "" });
    await fake.emit(fake.click("addOption", OWNER));
    expect(state.options).toHaveLength(0);
    expect(fake.notifies.at(-1)?.content).toContain("server I'm in");

    modal({ label: "General", emoji: "<:rules:123456789012345678>", description: "" });
    await fake.emit(fake.click("addOption", OWNER));
    expect(state.options).toHaveLength(1);
});

test(":name: finds the custom emoji by name; an unknown name is refused", async () => {
    const { deps, state, fake, modal } = setup({ panels: [row(1)] });
    void fake.run(panelEditorView(deps), undefined, OWNER);
    await fake.flush();
    await fake.emit(fake.click("open:0", OWNER));
    await fake.emit(fake.click("options", OWNER));

    modal({ label: "Sad", emoji: ":nope:", description: "" });
    await fake.emit(fake.click("addOption", OWNER));
    expect(state.options).toHaveLength(0);
    expect(fake.notifies.at(-1)?.content).toContain("no emoji called :nope:");

    modal({ label: "Sad", emoji: " :tragedy: ", description: "" });
    await fake.emit(fake.click("addOption", OWNER));
    expect(state.options[0].emoji).toBe("<:tragedy:123456789012345678>");
});

test("the busiest page the limits allow still fits Discord's 40 components and 4000 characters of text", async () => {
    const texts = 7;
    const chunk = (n: number): Block => ({ t: "text", v: "x".repeat(n) });
    const blocks: Block[] = [
        { t: "title", v: "T".repeat(settings.maxTitle) },
        { t: "img", url: "https://a.io/1.png" },
        { t: "img", url: "https://a.io/2.png" },
        ...Array.from({ length: texts - 1 }, () => chunk(414)),
        chunk(settings.maxPageChars - settings.maxTitle - 414 * (texts - 1)),
    ];
    expect(blocks).toHaveLength(settings.maxBlocks);
    const options = Array.from({ length: settings.maxOptions }, (_, i) => ({
        ...opt(10 + i, 1, `${i}`.padEnd(settings.maxLabel, "L")),
        description: "D".repeat(settings.maxDescription),
    }));
    const { deps, fake } = setup({ panels: [row(1, blocks)], options });
    void fake.run(panelEditorView(deps), undefined, OWNER);
    await fake.flush();
    await fake.emit(fake.click("open:0", OWNER));
    expect(text(fake.lastPayload())).toContain(`Text ${settings.maxPageChars}/${settings.maxPageChars}`);
    expect(nodes(fake.lastPayload()).length).toBeLessThanOrEqual(40);
    expect(text(fake.lastPayload()).length).toBeLessThanOrEqual(4000);

    await fake.emit(fake.click("options", OWNER));
    expect(nodes(fake.lastPayload()).length).toBeLessThanOrEqual(40);
    expect(text(fake.lastPayload()).length).toBeLessThanOrEqual(4000);
});
