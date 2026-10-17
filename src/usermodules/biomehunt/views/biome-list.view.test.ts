import { afterEach, expect, test } from "bun:test";
import { createFakeViewTransport, type ViewPayload } from "@/define";
import {
    type BiomeEntry,
    type BiomeMeta,
    getAllBiomes,
    getBiomeMeta,
    resetBiomeRegistry,
    setBiomeRegistry,
} from "../constants/biomes.constants";
import type { BiomeAdminDeps } from "../services/biome-admin.service";
import { biomeListView, buildCategoryTable } from "./biome-list.view";

const OWNER = "owner";

/** An in-memory `bh_biomes` - writes land in the registry on reload, like the real one. */
function createFakeDeps(): BiomeAdminDeps {
    const rows = new Map(getAllBiomes().map((e) => [e.key, e]));
    return {
        insertBiome: async () => false,
        updateBiome: async (key: string, meta: BiomeMeta) => {
            const row = rows.get(key);
            if (row) rows.set(key, { ...meta, key, enabled: row.enabled });
        },
        setBiomeEnabled: async (key: string, enabled: boolean) => {
            const row = rows.get(key);
            if (row) rows.set(key, { ...row, enabled });
        },
        reloadRegistry: async () => setBiomeRegistry([...rows.values()]),
    };
}

/** Opens the list and the given biome's card. */
async function openCard(category: string, biome: string) {
    const fake = createFakeViewTransport();
    void fake.run(biomeListView(createFakeDeps()), undefined, OWNER);
    await fake.flush();
    await fake.emit(fake.click("category", OWNER, [category]));
    await fake.emit(fake.click("biome", OWNER, [biome]));
    return fake;
}

afterEach(() => resetBiomeRegistry());

type Json = { custom_id?: string; content?: string; components?: Json[]; accessory?: Json; media?: { url?: string } };

/** Every component on the message, as plain JSON, depth-first - same local test glue as forward-list.view.test.ts. */
function flatten(payload: ViewPayload): Json[] {
    const out: Json[] = [];
    const walk = (node: unknown) => {
        if (node === null || typeof node !== "object") return;
        const json = typeof (node as { toJSON?: unknown }).toJSON === "function" ? (node as { toJSON(): unknown }).toJSON() : node;
        if (Array.isArray(json)) {
            for (const child of json) walk(child);
            return;
        }
        const obj = json as Json;
        out.push(obj);
        walk(obj.components);
        walk(obj.accessory);
    };
    walk(payload.components);
    return out;
}

function text(payload: ViewPayload): string {
    return flatten(payload)
        .map((c) => c.content ?? "")
        .filter(Boolean)
        .join("\n");
}

const hasComponent = (payload: ViewPayload, key: string) => flatten(payload).some((c) => c.custom_id?.endsWith(`:${key}`));

test("the table shows every category, then category -> biome opens its card and Back returns", async () => {
    const fake = createFakeViewTransport();
    void fake.run(biomeListView(createFakeDeps()), undefined, OWNER);
    await fake.flush();

    const list = text(fake.lastPayload());
    expect(list).toContain("Biomes · 20 enabled · 0 disabled");
    expect(list).toContain("**Rare (4)**");
    expect(list).toContain("SANDSTORM");
    expect(hasComponent(fake.lastPayload(), "biome")).toBe(false);

    await fake.emit(fake.click("category", OWNER, ["biome"]));
    expect(hasComponent(fake.lastPayload(), "biome")).toBe(true);

    await fake.emit(fake.click("biome", OWNER, ["HELL"]));
    const card = fake.lastPayload();
    expect(text(card)).toContain("Detection name: `HELL`");
    expect(text(card)).toContain("Color: `D7263D`");
    expect(flatten(card).some((c) => c.media?.url === "https://i.imgur.com/qf4ih2k.png")).toBe(true);

    await fake.emit(fake.click("back", OWNER));
    expect(text(fake.lastPayload())).toContain("Biomes · 20 enabled");
});

test("a disabled biome is counted and drawn gray in the table", () => {
    const entries: BiomeEntry[] = getAllBiomes().map((e) => (e.key === "HELL" ? { ...e, enabled: false } : e));
    setBiomeRegistry(entries);

    const table = buildCategoryTable(entries.filter((e) => e.category === "biome"));
    expect(table).toContain("\u001b[30mHell");
    expect(table).toMatch(/HELL\s+D7263D {2}- {2}disabled/);
});

test("table columns line up whatever the ANSI codes are", () => {
    const rows = buildCategoryTable(getAllBiomes().filter((e) => e.category === "rare"))
        .split("\n")
        .slice(1, -1)
        .map((line) =>
            line
                .split("\u001b[")
                .map((part, i) => (i === 0 ? part : part.replace(/^[\d;]*m/, "")))
                .join(""),
        );
    const keyColumn = rows.map((r) => r.search(/[A-Z]{4,}/));
    expect(new Set(keyColumn).size).toBe(1);
});

test("the card edits the biome in place: selects, toggles and the details form", async () => {
    const fake = await openCard("biome", "HELL");

    await fake.emit(fake.click("edit:category", OWNER, ["event"]));
    await fake.emit(fake.click("edit:ansi-background", OWNER, ["indigo"]));
    await fake.emit(fake.click("edit:bold", OWNER));
    await fake.emit(fake.click("edit:badge", OWNER));
    expect(getBiomeMeta("HELL")).toMatchObject({ category: "event", ansiColor: "\u001b[1;31;45m", hasBadge: true });
    expect(text(fake.lastPayload())).toContain("Hell** - Event");

    const ack = fake.modalSubmit(OWNER);
    fake.modalResult = async () => ({ values: { label: "Hell Fire", color: "ff0000", flavor: "", icon: "", duration: "2h" }, ack });
    await fake.emit(fake.click("edit:details", OWNER));
    expect(fake.modals[0].spec.fields.map((f) => f.key)).toEqual(["label", "color", "flavor", "icon", "duration"]);
    expect(getBiomeMeta("HELL")).toMatchObject({
        label: "Hell Fire",
        color: 0xff0000,
        durationS: 7200,
        flavorText: undefined,
        iconUrl: undefined,
    });

    await fake.emit(fake.click("edit:enabled", OWNER));
    expect(getBiomeMeta("HELL")?.enabled).toBe(false);
});

test("a bad value in the form is answered privately and changes nothing", async () => {
    const fake = await openCard("biome", "HELL");
    const ack = fake.modalSubmit(OWNER);
    fake.modalResult = async () => ({ values: { label: "Hell", color: "#ff0000", flavor: "", icon: "", duration: "" }, ack });
    await fake.emit(fake.click("edit:details", OWNER));

    expect(fake.notifies.at(-1)?.content).toContain("not a valid color");
    expect(getBiomeMeta("HELL")?.color).toBe(0xd7263d);
});
