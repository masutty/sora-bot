import { expect, test } from "bun:test";
import { option, panel } from "./panel.fixtures";
import { buildOptionPage, buildPreview, buildRootPage, pickCustomId } from "./panel.render";

const json = (payload: { components: { toJSON(): unknown }[] }) => JSON.stringify(payload.components.map((c) => c.toJSON()));

/** The select of a page: its customId, placeholder and option values. */
function selectOf(payload: { components: { toJSON(): unknown }[] }) {
    const found: { custom_id: string; placeholder?: string; disabled?: boolean; options: { value: string; label: string }[] }[] = [];
    const walk = (node: unknown) => {
        if (node === null || typeof node !== "object") return;
        const obj = node as Record<string, unknown>;
        if (Array.isArray(obj.options) && typeof obj.custom_id === "string") found.push(obj as never);
        for (const child of Object.values(obj)) walk(child);
    };
    for (const c of payload.components) walk(c.toJSON());
    return found[0];
}

test("root page: the blocks, then the select over every option, by option id", () => {
    const page = buildRootPage(panel(), [
        option(1, "General rules"),
        option(2, "Punishments", { emoji: "⚖️", description: "What happens" }),
    ]);
    const out = json(page);
    expect(out).toContain("## Server rules");
    expect(out).toContain("Read them.");
    expect(out).toContain("https://i.imgur.com/a.png");
    const select = selectOf(page);
    expect(select.custom_id).toBe(pickCustomId(7, "root"));
    expect(select.placeholder).toBe("Pick a category");
    expect(select.options.map((o) => o.value)).toEqual(["1", "2"]);
    expect(out).toContain("⚖️");
});

test("root page with no options has no select (Discord rejects an empty one)", () => {
    expect(selectOf(buildRootPage(panel(), []))).toBeUndefined();
});

test("an empty page still has content, since a container can't be empty", () => {
    expect(json(buildRootPage(panel({ blocks: [] }), []))).toContain("## Server rules");
    expect(json(buildOptionPage(panel(), [option(1, "Voice")], option(1, "Voice", { blocks: [] })))).toContain("## Voice");
});

test("option page: its blocks, and a select over the other options only - never the root, never itself", () => {
    const options = [option(1, "General"), option(2, "Chat"), option(3, "Voice")];
    const page = buildOptionPage(panel(), options, options[1]);
    const select = selectOf(page);
    expect(select.custom_id).toBe(pickCustomId(7, "eph"));
    expect(select.placeholder).toBe("Pick a category");
    expect(select.options.map((o) => o.value)).toEqual(["1", "3"]);
    expect(json(page)).toContain("## Chat");
    expect(json(page)).not.toContain("Read them.");
});

test("option page of the only option has no select", () => {
    const only = option(1, "General");
    expect(selectOf(buildOptionPage(panel(), [only], only))).toBeUndefined();
});

test("preview: same page, select switched off", () => {
    const options = [option(1, "General"), option(2, "Chat")];
    expect(selectOf(buildPreview(panel(), options, null)).disabled).toBe(true);
    const preview = buildPreview(panel(), options, options[0]);
    expect(selectOf(preview).options.map((o) => o.value)).toEqual(["2"]);
    expect(selectOf(preview).disabled).toBe(true);
});

test("a page never pings", () => {
    expect(buildRootPage(panel(), []).allowedMentions).toEqual({ parse: [] });
});
