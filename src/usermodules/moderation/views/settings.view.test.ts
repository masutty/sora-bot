import { expect, test } from "bun:test";
import { ButtonStyle } from "discord.js";
import { createFakeViewTransport, type ViewPayload } from "@/define";
import { defaultSettings } from "../repository/settings.repository";
import { EXAMPLE_LADDER } from "../services/ladder";
import type { ModSettings, Threshold } from "../types";
import { type SettingsDeps, settingsView } from "./settings.view";

const OWNER = "owner";

function nodes(payload: ViewPayload): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    const walk = (node: unknown) => {
        if (node === null || typeof node !== "object") return;
        const json = typeof (node as { toJSON?: unknown }).toJSON === "function" ? (node as { toJSON(): unknown }).toJSON() : node;
        if (Array.isArray(json)) return void json.forEach(walk);
        const obj = json as Record<string, unknown>;
        if (typeof obj.type === "number") out.push(obj);
        walk(obj.components);
        walk(obj.accessory);
    };
    walk(payload.components);
    return out;
}
const text = (p: ViewPayload) =>
    nodes(p)
        .map((n) => (typeof n.content === "string" ? n.content : ""))
        .join("\n");
const btn = (p: ViewPayload, key: string) => nodes(p).find((n) => typeof n.custom_id === "string" && n.custom_id.endsWith(`:${key}`));
const has = (p: ViewPayload, key: string) => btn(p, key) !== undefined;

async function open(ladder: Threshold[] = []) {
    let cfg: ModSettings = defaultSettings("g1");
    let stored = ladder;
    const deps: SettingsDeps = {
        guildId: "g1",
        getSettings: async () => cfg,
        updateSettings: async (_g, patch) => {
            cfg = { ...cfg, ...patch };
            return cfg;
        },
        getThresholds: async () => stored,
        replaceThresholds: async (_g, next) => {
            stored = next;
        },
    };
    const fake = createFakeViewTransport();
    void fake.run(settingsView(deps), undefined, OWNER);
    await fake.flush();
    return { fake, settings: () => cfg, ladder: () => stored };
}

async function submit(fake: Awaited<ReturnType<typeof open>>["fake"], key: string, values: Record<string, string>) {
    const ack = fake.modalSubmit(OWNER);
    fake.modalResult = async () => ({ values, ack });
    await fake.emit(fake.click(key, OWNER));
}

test("the main screen is one Section per setting in two groups, each with its button on the right", async () => {
    const { fake } = await open();
    const p = fake.lastPayload();
    const t = text(p);
    expect(t).toContain("**Moderator settings**");
    expect(t).toContain("**Moderator role:** none");
    expect(t).toContain("-# Members with this role can use every moderation command, and so can admins.");
    expect(t).toContain("**Case Channel:** none");
    expect(t).toContain("**Warn expiry:** 30 days");
    expect(t).toContain("**Auto-Punishment:** Off, no Thresholds");
    expect(t).toContain("-# Where every new or ended case is posted.");
    expect(t).toContain("-# Mutes, kicks or bans a member when their active warns reach a Threshold.");
    expect(t).toContain("**Auto-undo:** On");
    expect(t).toContain("**Appeal line:** none");
    expect(nodes(p).filter((n) => n.type === 9)).toHaveLength(6);
    expect(nodes(p).filter((n) => n.type === 14)).toHaveLength(2);
    expect(btn(p, "pickRole")).toMatchObject({ label: "Change" });
    expect(btn(p, "ladder")).toMatchObject({ label: "Edit Thresholds" });
    expect(btn(p, "auto")).toMatchObject({ label: "Turn on", style: ButtonStyle.Success });
    expect(btn(p, "undo")).toMatchObject({ label: "Turn off", style: ButtonStyle.Danger });
});

test("a set Appeal line is quoted in full under its explanation", async () => {
    const t = await open();
    await submit(t.fake, "appeal", { line: `${"x".repeat(100)}\nsecond` });
    const shown = text(t.fake.lastPayload());
    expect(shown).toContain("**Appeal line**\n-# Shown in punishment DMs so members know where to appeal.");
    expect(shown).toContain(`>>> ${"x".repeat(100)}\nsecond`);
});

test("the Case Channel picker saves and can be cleared, and returns to the main screen", async () => {
    const t = await open();
    await t.fake.emit(t.fake.click("pickChannel", OWNER));
    expect(has(t.fake.lastPayload(), "channel")).toBe(true);
    await t.fake.emit(t.fake.click("channel", OWNER, ["c9"]));
    expect(t.settings().case_channel_id).toBe("c9");
    expect(text(t.fake.lastPayload())).toContain("**Case Channel:** <#c9>");
    await t.fake.emit(t.fake.click("pickChannel", OWNER));
    await t.fake.emit(t.fake.click("channel", OWNER, []));
    expect(t.settings().case_channel_id).toBeNull();
});

test("the moderator role picker saves and can be cleared", async () => {
    const t = await open();
    await t.fake.emit(t.fake.click("pickRole", OWNER));
    await t.fake.emit(t.fake.click("role", OWNER, ["r7"]));
    expect(t.settings().moderator_role_id).toBe("r7");
    expect(text(t.fake.lastPayload())).toContain("**Moderator role:** <@&r7>");
    await t.fake.emit(t.fake.click("pickRole", OWNER));
    await t.fake.emit(t.fake.click("back", OWNER));
    expect(t.settings().moderator_role_id).toBe("r7");
    await t.fake.emit(t.fake.click("pickRole", OWNER));
    await t.fake.emit(t.fake.click("role", OWNER, []));
    expect(t.settings().moderator_role_id).toBeNull();
});

test("the toggles ask first and persist only on confirm", async () => {
    const t = await open();
    await t.fake.emit(t.fake.click("auto", OWNER));
    expect(text(t.fake.lastPayload())).toContain("Turn on Auto-Punishment?");
    expect(btn(t.fake.lastPayload(), "yes")).toMatchObject({ label: "Turn on", style: ButtonStyle.Success });
    expect(t.settings().auto_enabled).toBe(false);
    await t.fake.emit(t.fake.click("no", OWNER));
    expect(t.settings().auto_enabled).toBe(false);
    expect(btn(t.fake.lastPayload(), "auto")).toMatchObject({ label: "Turn on" });

    await t.fake.emit(t.fake.click("auto", OWNER));
    await t.fake.emit(t.fake.click("yes", OWNER));
    expect(t.settings().auto_enabled).toBe(true);
    expect(btn(t.fake.lastPayload(), "auto")).toMatchObject({ label: "Turn off", style: ButtonStyle.Danger });
    expect(text(t.fake.lastPayload())).toContain("**Auto-Punishment:** On");

    await t.fake.emit(t.fake.click("undo", OWNER));
    expect(btn(t.fake.lastPayload(), "yes")).toMatchObject({ label: "Turn off", style: ButtonStyle.Danger });
    await t.fake.emit(t.fake.click("yes", OWNER));
    expect(t.settings().auto_undo).toBe(false);
    expect(btn(t.fake.lastPayload(), "undo")).toMatchObject({ label: "Turn on" });
});

test("warn expiry takes 1-365 days only", async () => {
    const t = await open();
    await submit(t.fake, "expiry", { days: "400" });
    expect(t.fake.notifies[0]?.content).toContain("1 to 365");
    expect(t.settings().warn_expiry_days).toBe(30);
    await submit(t.fake, "expiry", { days: "7" });
    expect(t.settings().warn_expiry_days).toBe(7);
    expect(text(t.fake.lastPayload())).toContain("**Warn expiry:** 7 days");
});

test("the Appeal line saves and an empty one clears it", async () => {
    const t = await open();
    await submit(t.fake, "appeal", { line: "  Appeal at example.com  " });
    expect(t.settings().appeal_line).toBe("Appeal at example.com");
    expect(text(t.fake.lastPayload())).toContain(">>> Appeal at example.com");
    await submit(t.fake, "appeal", { line: "" });
    expect(t.settings().appeal_line).toBeNull();
    expect(text(t.fake.lastPayload())).toContain("**Appeal line:** none");
});

test("the Thresholds screen lists one Section per Threshold with Edit, and the footer buttons", async () => {
    const t = await open([
        { warns: 2, action: "mute", durationS: 3600 },
        { warns: 3, action: null, durationS: null },
        { warns: 5, action: "ban", durationS: null },
    ]);
    await t.fake.emit(t.fake.click("ladder", OWNER));
    const p = t.fake.lastPayload();
    expect(text(p)).toContain("**2 warns:** Mute 1h");
    expect(text(p)).toContain("**3 warns:** No action");
    expect(text(p)).toContain("**5 warns:** Ban");
    expect(btn(p, "edit:2")).toMatchObject({ label: "Edit" });
    expect(btn(p, "edit:3")).toBeUndefined();
    for (const key of ["add", "example", "back"]) expect(btn(p, key)).toBeDefined();
    await t.fake.emit(t.fake.click("back", OWNER));
    expect(text(t.fake.lastPayload())).toContain("**Moderator settings**");
});

test("an empty ladder says No Thresholds.", async () => {
    const t = await open();
    await t.fake.emit(t.fake.click("ladder", OWNER));
    expect(text(t.fake.lastPayload())).toContain("No Thresholds.");
});

test("adds a Threshold, refuses a repeated count and a mute without duration", async () => {
    const t = await open([{ warns: 2, action: "kick", durationS: null }]);
    await t.fake.emit(t.fake.click("ladder", OWNER));
    await submit(t.fake, "add", { warns: "1", action: "mute", duration: "1h" });
    expect(t.ladder().map((x) => x.warns)).toEqual([1, 2]);
    await submit(t.fake, "add", { warns: "2", action: "ban", duration: "" });
    expect(t.fake.notifies.at(-1)?.content).toContain("already a Threshold at 2");
    await submit(t.fake, "add", { warns: "3", action: "mute", duration: "" });
    expect(t.fake.notifies.at(-1)?.content).toContain("needs a duration");
    expect(t.ladder()).toHaveLength(2);
    expect(text(t.fake.lastPayload())).toContain("**1 warn:** Mute 1h");
});

test("Edit changes that Threshold, and an emptied warns count removes it", async () => {
    const t = await open([
        { warns: 2, action: "kick", durationS: null },
        { warns: 4, action: "ban", durationS: null },
    ]);
    await t.fake.emit(t.fake.click("ladder", OWNER));
    await submit(t.fake, "edit:0", { warns: "3", action: "ban", duration: "" });
    expect(t.ladder()).toEqual([
        { warns: 3, action: "ban", durationS: null },
        { warns: 4, action: "ban", durationS: null },
    ]);
    await submit(t.fake, "edit:1", { warns: " ", action: "", duration: "" });
    expect(t.ladder()).toEqual([{ warns: 3, action: "ban", durationS: null }]);
    expect(btn(t.fake.lastPayload(), "edit:1")).toBeUndefined();
});

test("more than 5 Thresholds paginate and Edit follows the page", async () => {
    const ladder: Threshold[] = Array.from({ length: 7 }, (_, i) => ({ warns: i + 1, action: "kick", durationS: null }));
    const t = await open(ladder);
    await t.fake.emit(t.fake.click("ladder", OWNER));
    expect(btn(t.fake.lastPayload(), "jump")).toMatchObject({ label: "1 / 2" });
    expect(text(t.fake.lastPayload())).not.toContain("**6 warns:**");
    await t.fake.emit(t.fake.click("next", OWNER));
    expect(text(t.fake.lastPayload())).toContain("**6 warns:** Kick");
    await submit(t.fake, "edit:0", { warns: "", action: "", duration: "" });
    expect(t.ladder().map((x) => x.warns)).toEqual([1, 2, 3, 4, 5, 7]);
});

test("Use example replaces the ladder after confirming", async () => {
    const t = await open([{ warns: 9, action: "ban", durationS: null }]);
    await t.fake.emit(t.fake.click("ladder", OWNER));
    await t.fake.emit(t.fake.click("example", OWNER));
    expect(t.ladder()).toEqual([{ warns: 9, action: "ban", durationS: null }]);
    await t.fake.emit(t.fake.click("yes", OWNER));
    expect(t.ladder()).toEqual(EXAMPLE_LADDER);
    expect(has(t.fake.lastPayload(), "add")).toBe(true);
});
