import { expect, test } from "bun:test";
import { createFakeViewTransport, type ViewPayload } from "@/define";
import { type SettingsDeps, type SettingsInput, settingsView } from "./settings.view";

const OWNER = "owner";
const GUILD = "g1";

type Json = { custom_id?: string; label?: string; disabled?: boolean; content?: string; components?: Json[]; accessory?: Json };

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

const text = (payload: ViewPayload) =>
    flatten(payload)
        .map((c) => c.content ?? "")
        .filter(Boolean)
        .join("\n");

const comp = (payload: ViewPayload, key: string): Json => {
    const found = flatten(payload).find((c) => c.custom_id?.endsWith(`:${key}`));
    if (!found) throw new Error(`No component "${key}"`);
    return found;
};

const baseInput = (over: Partial<SettingsInput> = {}): SettingsInput => ({
    guildId: GUILD,
    gapS: 1200,
    idleS: 1800,
    inactiveS: 86400,
    deleteAfterS: 72 * 3600,
    autoCreateCategories: false,
    counterChannelId: null,
    roles: { active: null, idle: null, inactive: null },
    categoryIds: ["cat1"],
    autoDelete: false,
    clearProfileOnAutoDelete: false,
    ...over,
});

/** Fake deps that only record their calls. */
function fakeDeps(opts: { canAssign?: boolean; reloaded?: SettingsInput } = {}) {
    const calls: unknown[][] = [];
    const rec =
        <T>(name: string, ret?: T) =>
        async (...args: unknown[]) => {
            calls.push([name, ...args]);
            return ret as T;
        };
    const deps: SettingsDeps = {
        updateThresholds: rec("updateThresholds"),
        setGuildRoleForStatus: rec("setGuildRoleForStatus"),
        insertCategory: rec("insertCategory"),
        deleteCategory: rec("deleteCategory", true),
        updateAutoCreateCategories: rec("updateAutoCreateCategories"),
        setAutoDeleteHours: rec("setAutoDeleteHours"),
        setGuildFlag: rec("setGuildFlag"),
        updateCounterChannel: rec("updateCounterChannel"),
        clearCounterChannel: rec("clearCounterChannel"),
        forceCounterUpdate: rec("forceCounterUpdate", "Live counter updated."),
        resetGuildConfig: rec("resetGuildConfig"),
        canAssignRole: () => opts.canAssign ?? true,
        reload: async () => opts.reloaded ?? baseInput(),
        counts: async () => ({ active: 12, idle: 4, inactive: 31 }),
    };
    return { deps, calls };
}

async function open(input: SettingsInput = baseInput(), depOpts: Parameters<typeof fakeDeps>[0] = {}) {
    const { deps, calls } = fakeDeps(depOpts);
    const fake = createFakeViewTransport();
    void fake.run(settingsView(deps), input, OWNER);
    await fake.flush();
    return { fake, calls };
}

/** Clicks `key` and answers the modal it opens with `values`. */
async function submitForm(fake: Awaited<ReturnType<typeof open>>["fake"], key: string, values: Record<string, string>) {
    const ack = fake.modalSubmit(OWNER);
    fake.modalResult = async () => ({ values, ack });
    await fake.emit(fake.click(key, OWNER));
}

test("opens on not-ready when there's no category", async () => {
    const { fake } = await open(baseInput({ categoryIds: [] }));
    const t = text(fake.lastPayload());
    expect(t).toContain("NOT READY YET");
    expect(t).toContain("Macro channels");
    expect(t).not.toContain("Status roles");

    await fake.emit(fake.click("showAll", OWNER));
    expect(text(fake.lastPayload())).toContain("Status roles");
});

test("overview shows each setting in plain words", async () => {
    const { fake } = await open(baseInput({ roles: { active: "r1", idle: null, inactive: null }, counterChannelId: "c9" }));
    const t = text(fake.lastPayload());
    expect(t).toContain("A session ends `20m` after the last macro message. Idle `30m` after a session ends, inactive after `24h`.");
    expect(t).toContain("🟢 <@&r1> · 🟡 no role · 🔴 no role");
    expect(t).toContain("New channels go in <#cat1>.");
    expect(t).toContain("In <#c9>");
});

test("activity form saves minutes/hours as seconds; empty fields use defaults", async () => {
    const { fake, calls } = await open();
    await submitForm(fake, "edit:activity", { gap: "", idle: "45", inactive: "" });
    expect(calls).toEqual([["updateThresholds", GUILD, 1200, 2700, 86400]]);
    expect(fake.modals.at(-1)?.spec.text).toContain("Leave a field empty to use the default.");
    expect(text(fake.lastPayload())).toContain("Idle `45m`");
});

test("activity form refuses bad input", async () => {
    const { fake, calls } = await open();
    await submitForm(fake, "edit:activity", { gap: "", idle: "abc", inactive: "" });
    expect(fake.notifies.at(-1)?.content).toContain("Idle");
    expect(calls).toHaveLength(0);
});

test("a status role select saves the picked role", async () => {
    const { fake, calls } = await open();
    await fake.emit(fake.click("edit:roles", OWNER));
    await fake.emit(fake.click("role:active", OWNER, ["r1"]));
    expect(calls).toEqual([["setGuildRoleForStatus", GUILD, "active", "r1"]]);
});

test("clearing a status role select unsets only that status", async () => {
    const { fake, calls } = await open(baseInput({ roles: { active: "r1", idle: "r2", inactive: null } }));
    await fake.emit(fake.click("edit:roles", OWNER));
    await fake.emit(fake.click("role:idle", OWNER, []));
    expect(calls).toEqual([["setGuildRoleForStatus", GUILD, "idle", null]]);
});

test("refuses a role above the bot", async () => {
    const { fake, calls } = await open(baseInput(), { canAssign: false });
    await fake.emit(fake.click("edit:roles", OWNER));
    await fake.emit(fake.click("role:active", OWNER, ["r1"]));
    expect(fake.notifies.at(-1)?.content).toBe("I can't give that role - it's above my highest role.");
    expect(calls).toHaveLength(0);
});

test("macro channels select saves only the difference", async () => {
    const { fake, calls } = await open(baseInput({ categoryIds: ["a", "b"] }));
    await fake.emit(fake.click("edit:channels", OWNER));
    await fake.emit(fake.click("categories", OWNER, ["b", "c"]));
    expect(calls).toEqual([
        ["insertCategory", GUILD, "c"],
        ["deleteCategory", GUILD, "a"],
    ]);
});

test("auto-create switch flips", async () => {
    const { fake, calls } = await open();
    await fake.emit(fake.click("edit:channels", OWNER));
    expect(comp(fake.lastPayload(), "autocreate").label).toBe("Turn on");
    await fake.emit(fake.click("autocreate", OWNER));
    expect(calls).toEqual([["updateAutoCreateCategories", GUILD, true]]);
    expect(comp(fake.lastPayload(), "autocreate").label).toBe("Turn off");
});

test("auto-delete switch writes AUTO_DELETE_ENABLED", async () => {
    const { fake, calls } = await open();
    await fake.emit(fake.click("edit:autodelete", OWNER));
    await fake.emit(fake.click("ad:toggle", OWNER));
    expect(calls).toEqual([["setGuildFlag", GUILD, "AUTO_DELETE_ENABLED", true]]);
});

test("auto-delete hours form saves seconds and refuses bad input", async () => {
    const { fake, calls } = await open();
    await fake.emit(fake.click("edit:autodelete", OWNER));
    await submitForm(fake, "ad:after", { after: "48" });
    expect(calls).toEqual([["setAutoDeleteHours", GUILD, 48 * 3600]]);

    await submitForm(fake, "ad:after", { after: "soon" });
    expect(calls).toHaveLength(1);
    expect(fake.notifies).toHaveLength(1);
});

test("what-it-does writes CLEAR_PROFILE_ON_AUTODELETE", async () => {
    const { fake, calls } = await open();
    await fake.emit(fake.click("edit:autodelete", OWNER));
    await fake.emit(fake.click("ad:what", OWNER));
    expect(comp(fake.lastPayload(), "what:unlink")).toMatchObject({ label: "Chosen", disabled: true });
    await fake.emit(fake.click("what:wipe", OWNER));
    expect(calls).toEqual([["setGuildFlag", GUILD, "CLEAR_PROFILE_ON_AUTODELETE", true]]);
    expect(text(fake.lastPayload())).toContain("Deletes everything");
});

test("counter: picking a channel sets it", async () => {
    const { fake, calls } = await open();
    await fake.emit(fake.click("edit:counter", OWNER));
    await fake.emit(fake.click("counter", OWNER, ["c9"]));
    expect(calls).toEqual([["updateCounterChannel", GUILD, "c9"]]);
});

test("counter: clearing the select disables it", async () => {
    const { fake, calls } = await open(baseInput({ counterChannelId: "c9" }));
    await fake.emit(fake.click("edit:counter", OWNER));
    await fake.emit(fake.click("counter", OWNER, []));
    expect(calls).toEqual([["clearCounterChannel", GUILD]]);
});

test("counter: Refresh now updates it, and asks for a channel first when there is none", async () => {
    const { fake, calls } = await open();
    await fake.emit(fake.click("edit:counter", OWNER));
    await fake.emit(fake.click("refresh", OWNER));
    expect(fake.notifies.at(-1)?.content).toBe("Pick a channel first.");
    expect(calls).toHaveLength(0);

    await fake.emit(fake.click("counter", OWNER, ["c9"]));
    await fake.emit(fake.click("refresh", OWNER));
    expect(calls.at(-1)).toEqual(["forceCounterUpdate", GUILD]);
    expect(fake.notifies.at(-1)?.content).toBe("Live counter updated.");
});

test("reset needs the word reset", async () => {
    const { fake, calls } = await open();
    await submitForm(fake, "reset", { confirm: "nope" });
    expect(calls).toHaveLength(0);
    expect(fake.notifies).toHaveLength(1);

    await submitForm(fake, "reset", { confirm: "reset" });
    expect(calls).toEqual([
        ["resetGuildConfig", GUILD],
        ["setGuildFlag", GUILD, "AUTO_DELETE_ENABLED", false],
        ["setGuildFlag", GUILD, "CLEAR_PROFILE_ON_AUTODELETE", false],
    ]);
});

test("reset reloads the settings and lands on the not-ready screen", async () => {
    const { fake } = await open(baseInput(), { reloaded: baseInput({ categoryIds: [] }) });
    await submitForm(fake, "reset", { confirm: "reset" });
    expect(text(fake.lastPayload())).toContain("NOT READY YET");
});

test("Close ends the view", async () => {
    const { fake } = await open();
    await fake.emit(fake.click("close", OWNER));
    expect(fake.closed).toBe(1);
});

test("counter screen previews the real counts", async () => {
    const { fake } = await open();
    await fake.emit(fake.click("edit:counter", OWNER));
    const t = text(fake.lastPayload());
    expect(t).toContain("Active: `12`");
    expect(t).toContain("Idle: `4`");
    expect(t).toContain("Inactive: `31`");
});

test("durations show as hours, and Back from What it does returns to Auto-delete", async () => {
    const { fake } = await open();
    await fake.emit(fake.click("edit:autodelete", OWNER));
    expect(text(fake.lastPayload())).toContain("`72h` inactive");
    await fake.emit(fake.click("ad:what", OWNER));
    await fake.emit(fake.click("back:autodelete", OWNER));
    expect(text(fake.lastPayload())).toContain("**Auto-delete inactive members**");
});

test("activity form is prefilled with the current values, so editing one keeps the others", async () => {
    const { fake, calls } = await open(baseInput({ gapS: 900, idleS: 1800, inactiveS: 48 * 3600 }));
    await submitForm(fake, "edit:activity", { gap: "15", idle: "45", inactive: "48" });
    const fields = fake.modals.at(-1)?.spec.fields ?? [];
    expect(fields.map((f) => f.value)).toEqual(["15", "30", "48"]);
    expect(calls).toEqual([["updateThresholds", GUILD, 900, 2700, 172800]]);
});
