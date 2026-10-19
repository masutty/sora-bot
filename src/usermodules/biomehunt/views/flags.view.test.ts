import { expect, test } from "bun:test";
import { ButtonStyle } from "discord.js";
import { createFakeViewTransport, type ViewPayload } from "@/define";
import { ALL_FLAGS, FLAG_DEFINITIONS, MENU_FLAGS } from "../constants/flags.constants";
import type { FlagName } from "../types";
import { FLAGS_PER_PAGE, type FlagsDeps, flagsView } from "./flags.view";

const OWNER = "owner";
const GUILD_ID = "g1";

type Json = {
    custom_id?: string;
    label?: string;
    style?: number;
    content?: string;
    accent_color?: number;
    components?: Json[];
    accessory?: Json;
};

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

function comp(payload: ViewPayload, key: string): Json {
    const found = flatten(payload).find((c) => c.custom_id?.endsWith(`:${key}`));
    if (!found) throw new Error(`No component "${key}"`);
    return found;
}

const toggleCount = (payload: ViewPayload) => flatten(payload).filter((c) => c.custom_id?.includes(":toggle:")).length;

/** A `FlagsDeps` that never touches the DB - it only records the writes. */
function fakeDeps() {
    const calls: Array<{ guildId: string; flag: FlagName; enabled: boolean }> = [];
    const deps: FlagsDeps = {
        setFlag: async (guildId, flag, enabled) => {
            calls.push({ guildId, flag, enabled });
        },
    };
    return { deps, calls };
}

async function open(overrides: Partial<Record<FlagName, boolean>> = {}) {
    const flags = Object.fromEntries(ALL_FLAGS.map((f) => [f, overrides[f] ?? false])) as Record<FlagName, boolean>;
    const { deps, calls } = fakeDeps();
    const fake = createFakeViewTransport();
    void fake.run(flagsView(deps), { guildId: GUILD_ID, flags }, OWNER);
    await fake.flush();
    return { fake, calls };
}

test("flags: renders the header, key + default and the right button per state", async () => {
    const { fake } = await open({ REPORT_SESSION_ON_END: true });
    const payload = fake.lastPayload();

    expect(text(payload)).toContain("**Flags**\nTurn optional features on or off for this server.");
    expect(text(payload)).toContain("`✅` **REPORT_SESSION_ON_END** (default: OFF)");
    expect(text(payload)).toContain("`❌` **PING_ON_QUOTA_MET** (default: OFF)");
    expect(comp(payload, "toggle:REPORT_SESSION_ON_END")).toMatchObject({ label: "Turn off", style: ButtonStyle.Danger });
    expect(comp(payload, "toggle:PING_ON_QUOTA_MET")).toMatchObject({ label: "Turn on", style: ButtonStyle.Success });
    expect(text(payload)).toContain(`-# ${FLAG_DEFINITIONS.PING_ON_QUOTA_MET.description}`);
});

test("flags menu no longer lists the two auto-delete flags", async () => {
    const { fake } = await open();
    expect(MENU_FLAGS).toEqual(ALL_FLAGS.filter((f) => f !== "AUTO_DELETE_ENABLED" && f !== "CLEAR_PROFILE_ON_AUTODELETE"));
    expect(toggleCount(fake.lastPayload())).toBe(MENU_FLAGS.length);
    expect(text(fake.lastPayload())).not.toContain("AUTO_DELETE_ENABLED");
    expect(text(fake.lastPayload())).not.toContain("CLEAR_PROFILE_ON_AUTODELETE");
});

test("flags: paginates MENU_FLAGS - no pagination row while they fit one page", async () => {
    const { fake } = await open();
    expect(MENU_FLAGS.length).toBeLessThanOrEqual(FLAGS_PER_PAGE);
    expect(() => comp(fake.lastPayload(), "jump")).toThrow();
});

test("flags: a flag that explains both states shows On/Off subtext lines", async () => {
    const { fake } = await open();
    const def = FLAG_DEFINITIONS.EXPERIMENT_BIOME_ECONOMY;
    expect(text(fake.lastPayload())).toContain(`-# **On:** ${def.on}\n-# **Off:** ${def.off}`);
});

test("flags: Turn on opens a green confirm with only the On line; Confirm saves and returns to the same page, flipped", async () => {
    const { fake, calls } = await open();
    await fake.emit(fake.click("toggle:EXPERIMENT_WEBHOOK_FLOWERS", OWNER));

    const asking = fake.lastPayload();
    const def = FLAG_DEFINITIONS.EXPERIMENT_WEBHOOK_FLOWERS;
    expect(text(asking)).toContain("**Turn on this flag?**");
    expect(text(asking)).toContain("**EXPERIMENT_WEBHOOK_FLOWERS** (default: OFF)");
    // Only the line that will apply, as a plain sentence - no "On:" label on the confirm.
    expect(text(asking)).toContain("Macro webhooks get a random Flower name and avatar on setup");
    expect(text(asking)).not.toContain("**On:**");
    expect(text(asking)).not.toContain(def.off as string);
    expect(comp(asking, "yes")).toMatchObject({ label: "Turn on", style: ButtonStyle.Success });
    expect(comp(asking, "no")).toMatchObject({ label: "Cancel", style: ButtonStyle.Secondary });
    expect(flatten(asking)[0].accent_color).toBe(0x248046);

    await fake.emit(fake.click("yes", OWNER));
    expect(calls).toEqual([{ guildId: GUILD_ID, flag: "EXPERIMENT_WEBHOOK_FLOWERS", enabled: true }]);
    expect(comp(fake.lastPayload(), "toggle:EXPERIMENT_WEBHOOK_FLOWERS")).toMatchObject({ label: "Turn off", style: ButtonStyle.Danger });
});

test("flags: Turn off opens a red confirm with only the Off line", async () => {
    const { fake } = await open({ EXPERIMENT_BIOME_ECONOMY: true });
    await fake.emit(fake.click("toggle:EXPERIMENT_BIOME_ECONOMY", OWNER));

    const asking = fake.lastPayload();
    const def = FLAG_DEFINITIONS.EXPERIMENT_BIOME_ECONOMY;
    expect(text(asking)).toContain("**Turn off this flag?**");
    expect(text(asking)).toContain("Biome badges still work, but no Seeds/XP are earned or shown.");
    expect(text(asking)).not.toContain("**Off:**");
    expect(text(asking)).not.toContain(def.on as string);
    expect(comp(asking, "yes")).toMatchObject({ label: "Turn off", style: ButtonStyle.Danger });
    expect(flatten(asking)[0].accent_color).toBe(0xda373c);
});

test("flags: a flag with a single description shows it in the confirm", async () => {
    const { fake } = await open();
    await fake.emit(fake.click("toggle:PING_ON_QUOTA_MET", OWNER));
    expect(text(fake.lastPayload())).toContain(FLAG_DEFINITIONS.PING_ON_QUOTA_MET.description as string);
});

test("flags: Cancel saves nothing and returns to the same page unchanged", async () => {
    const { fake, calls } = await open();
    await fake.emit(fake.click("toggle:PING_ON_QUOTA_MET", OWNER));
    await fake.emit(fake.click("no", OWNER));

    expect(calls).toHaveLength(0);
    expect(comp(fake.lastPayload(), "toggle:PING_ON_QUOTA_MET")).toMatchObject({ label: "Turn on", style: ButtonStyle.Success });
});
