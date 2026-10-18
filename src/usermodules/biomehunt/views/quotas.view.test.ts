import { expect, test } from "bun:test";
import { createFakeViewTransport, type ViewPayload } from "@/define";
import type { QuotaRoleMode, QuotaRoleRow } from "../types";
import { type QuotasDeps, type QuotasInput, quotasView } from "./quotas.view";

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

const quota = (roleId: string, mode: QuotaRoleMode, targetS: number, windowH: number, days: number | null): QuotaRoleRow => ({
    id: 1,
    guild_id: GUILD,
    role_id: roleId,
    mode,
    quota_target_seconds: targetS,
    quota_window_hours: windowH,
    access_duration_days: days,
    created_at: new Date(0),
    updated_at: new Date(0),
});

const DAILY = quota("r1", "F", 6 * 3600, 24, 3);
const LIVE = quota("r2", "RW", 20 * 3600, 168, null);

const baseInput = (quotas: QuotaRoleRow[] = [DAILY, LIVE]): QuotasInput => ({
    guildId: GUILD,
    quotas,
    holders: { r1: 14, r2: 1 },
    evalHourUtc: 21,
});

let holderCount = 0;

function fakeDeps(opts: { canAssign?: boolean } = {}) {
    const calls: unknown[][] = [];
    const deps: QuotasDeps = {
        upsertQuotaRole: async (guildId, roleId, mode, targetS, windowH, days) => {
            calls.push(["upsertQuotaRole", guildId, roleId, mode, targetS, windowH, days]);
            return quota(roleId, mode, targetS, windowH, days);
        },
        deleteQuotaRole: async (guildId, roleId) => {
            calls.push(["deleteQuotaRole", guildId, roleId]);
            return true;
        },
        updateQuotaEvalHour: async (guildId, hour) => {
            calls.push(["updateQuotaEvalHour", guildId, hour]);
        },
        forceQuotaEval: async (guildId) => {
            calls.push(["forceQuotaEval", guildId]);
            return "Checked 2 daily rewards.";
        },
        countHolders: async () => holderCount,
        countHitToday: async () => 9,
        canAssignRole: () => opts.canAssign ?? true,
        roleInfo: (roleId) => ({ name: `Role ${roleId}`, color: 0x112233 }),
        loadStats: async () => {
            throw new Error("not used");
        },
    };
    return { deps, calls };
}

async function open(input: QuotasInput = baseInput(), depOpts: Parameters<typeof fakeDeps>[0] = {}) {
    const { deps, calls } = fakeDeps(depOpts);
    const fake = createFakeViewTransport();
    void fake.run(quotasView(deps), input, OWNER);
    await fake.flush();
    return { fake, calls };
}

async function submitForm(fake: Awaited<ReturnType<typeof open>>["fake"], key: string, values: Record<string, string>) {
    const ack = fake.modalSubmit(OWNER);
    fake.modalResult = async () => ({ values, ack });
    await fake.emit(fake.click(key, OWNER));
}

test("lists quotas as sentences", async () => {
    const { fake } = await open();
    const t = text(fake.lastPayload());
    expect(t).toContain("<@&r1> · Daily reward\nMacro `6h` in a day → keep it `3 days`\n-# 14 members have it");
    expect(t).toContain("<@&r2> · Live role\nHave `20h` in the last `7 days`\n-# 1 member has it");
    expect(t).toMatch(/-# ⏰ Daily rewards are checked every day at <t:\d+:t>/);
});

test('empty list says "No quotas yet."', async () => {
    const { fake } = await open(baseInput([]));
    expect(text(fake.lastPayload())).toContain("No quotas yet.");
});

test("daily edit form has no window field and saves 24", async () => {
    const { fake, calls } = await open();
    await fake.emit(fake.click("edit:0", OWNER));
    expect(text(fake.lastPayload())).toContain("- Role lasts: `3 days` after each day they hit it");
    expect(text(fake.lastPayload())).toContain("-# 14 members have it · 9 hit it today");

    await submitForm(fake, "editNumbers", { target: "5h", extra: "2" });
    const spec = fake.modals.at(-1)?.spec;
    expect(spec?.fields.map((f) => f.label)).toEqual(["Macro time needed (e.g. 6h or 1h30m)", "Role lasts (days)"]);
    expect(spec?.fields.map((f) => f.value)).toEqual(["6h", "3"]);
    expect(calls).toEqual([["upsertQuotaRole", GUILD, "r1", "F", 5 * 3600, 24, 2]]);
});

test('live edit form accepts "7d" as 168', async () => {
    const { fake, calls } = await open();
    await fake.emit(fake.click("edit:1", OWNER));
    await submitForm(fake, "editNumbers", { target: "10h", extra: "7d" });
    expect(fake.modals.at(-1)?.spec.fields[1]?.value).toBe("7d");
    expect(calls).toEqual([["upsertQuotaRole", GUILD, "r2", "RW", 10 * 3600, 168, null]]);
});

test('bad target "abc" notifies, saves nothing', async () => {
    const { fake, calls } = await open();
    await fake.emit(fake.click("edit:0", OWNER));
    await submitForm(fake, "editNumbers", { target: "abc", extra: "3" });
    expect(fake.notifies.at(-1)?.content).toContain("Macro time needed");
    expect(calls).toHaveLength(0);
});

test("preset Daily grinder saves F/5h/24/1 and opens its editor", async () => {
    const { fake, calls } = await open(baseInput([]));
    await fake.emit(fake.click("add", OWNER));
    await fake.emit(fake.click("addRole", OWNER, ["r9"]));
    await fake.emit(fake.click("preset", OWNER, ["daily-grinder"]));
    expect(calls).toEqual([["upsertQuotaRole", GUILD, "r9", "F", 5 * 3600, 24, 1]]);
    expect(text(fake.lastPayload())).toContain("- Role lasts: `1 day`");
});

test("preset Weekly saves RW/20h/168", async () => {
    const { fake, calls } = await open(baseInput([]));
    await fake.emit(fake.click("add", OWNER));
    await fake.emit(fake.click("addRole", OWNER, ["r9"]));
    await fake.emit(fake.click("preset", OWNER, ["weekly"]));
    expect(calls).toEqual([["upsertQuotaRole", GUILD, "r9", "RW", 20 * 3600, 168, null]]);
});

test("Custom goes to the type screen, then the form", async () => {
    const { fake, calls } = await open(baseInput([]));
    await fake.emit(fake.click("add", OWNER));
    await fake.emit(fake.click("addRole", OWNER, ["r9"]));
    await fake.emit(fake.click("preset", OWNER, ["custom"]));
    expect(text(fake.lastPayload())).toContain("How should members earn it?");
    await submitForm(fake, "type:F", { target: "2h", extra: "4" });
    expect(calls).toEqual([["upsertQuotaRole", GUILD, "r9", "F", 2 * 3600, 24, 4]]);
});

test("role above the bot is refused", async () => {
    const { fake, calls } = await open(baseInput([]), { canAssign: false });
    await fake.emit(fake.click("add", OWNER));
    await fake.emit(fake.click("addRole", OWNER, ["r9"]));
    expect(fake.notifies.at(-1)?.content).toBe("I can't give that role - it's above my highest role.");
    expect(calls).toHaveLength(0);
});

test("check time form explains itself and saves the hour", async () => {
    const { fake, calls } = await open();
    await submitForm(fake, "checkTime", { hour: "9" });
    const spec = fake.modals.at(-1)?.spec;
    expect(spec?.text).toContain("All daily rewards are checked at this hour.");
    expect(spec?.fields[0]?.label).toBe("Hour in UTC (0-23)");
    expect(calls).toEqual([["updateQuotaEvalHour", GUILD, 9]]);

    await submitForm(fake, "checkTime", { hour: "24" });
    expect(calls).toHaveLength(1);
    expect(fake.notifies).toHaveLength(1);
});

test("check now asks first", async () => {
    const { fake, calls } = await open();
    await fake.emit(fake.click("checkNow", OWNER));
    expect(text(fake.lastPayload())).toContain("Check daily rewards now?");
    expect(calls).toHaveLength(0);
    await fake.emit(fake.click("yes", OWNER));
    expect(calls).toEqual([["forceQuotaEval", GUILD]]);
});

test("delete confirm mentions the holder count, then the quota is gone", async () => {
    const { fake, calls } = await open();
    await fake.emit(fake.click("edit:0", OWNER));
    await fake.emit(fake.click("delete", OWNER));
    expect(text(fake.lastPayload())).toContain("-# The 14 members who have it keep it until it runs out.");
    expect(calls).toHaveLength(0);
    await fake.emit(fake.click("yes", OWNER));
    expect(calls).toEqual([["deleteQuotaRole", GUILD, "r1"]]);
    expect(text(fake.lastPayload())).not.toContain("<@&r1>");
});

test("check now reloads the holder counts after the check runs", async () => {
    holderCount = 0;
    const { fake } = await open();
    expect(text(fake.lastPayload())).toContain("14 members have it");
    await fake.emit(fake.click("checkNow", OWNER));
    holderCount = 20;
    await fake.emit(fake.click("yes", OWNER));
    const t = text(fake.lastPayload());
    expect(t).toContain("20 members have it");
    expect(t).not.toContain("14 members have it");
    holderCount = 0;
});

test("check now tells the result in a notice", async () => {
    const { fake } = await open();
    await fake.emit(fake.click("checkNow", OWNER));
    await fake.emit(fake.click("yes", OWNER));
    expect(fake.notifies.at(-1)?.content).toBe("Checked 2 daily rewards.");
});

test("check now with no daily rewards says so and opens no confirm", async () => {
    const { fake, calls } = await open(baseInput([LIVE]));
    await fake.emit(fake.click("checkNow", OWNER));
    expect(fake.notifies.at(-1)?.content).toBe("No daily rewards to check.");
    expect(text(fake.lastPayload())).not.toContain("Check daily rewards now?");
    expect(calls).toHaveLength(0);
});

test("deleting a live role says the members keep the role until an admin removes it", async () => {
    const { fake } = await open();
    await fake.emit(fake.click("edit:1", OWNER));
    await fake.emit(fake.click("delete", OWNER));
    expect(text(fake.lastPayload())).toContain("-# The 1 member who has it keeps the role until an admin removes it.");
});
