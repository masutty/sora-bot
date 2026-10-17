import { afterEach, expect, test } from "bun:test";
import { createFakeViewTransport, type ViewPayload } from "@/define";
import { type BiomeEntry, getAllBiomes, resetBiomeRegistry, setBiomeRegistry } from "../constants/biomes.constants";
import { biomeListView, buildCategoryTable } from "./biome-list.view";

const OWNER = "owner";

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
    void fake.run(biomeListView, undefined, OWNER);
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
