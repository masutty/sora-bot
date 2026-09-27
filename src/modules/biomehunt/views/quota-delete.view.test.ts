import { expect, test } from "bun:test";
import { createFakeViewTransport, type ViewPayload } from "@/define";
import { settings } from "../settings";
import type { QuotaRoleRow } from "../types";
import { type QuotaDeleteDeps, quotaDeleteView } from "./quota-delete.view";

const OWNER = "owner";
const OTHER = "someone-else";
const GUILD_ID = "g1";

const ROLE_1: QuotaRoleRow = {
    id: 1,
    guild_id: GUILD_ID,
    role_id: "r1",
    mode: "F",
    quota_target_seconds: 3600 * 5,
    quota_window_hours: 24,
    access_duration_days: 7,
    created_at: new Date(),
    updated_at: new Date(),
};

const ROLE_2: QuotaRoleRow = {
    id: 2,
    guild_id: GUILD_ID,
    role_id: "r2",
    mode: "RW",
    quota_target_seconds: 3600 * 10,
    quota_window_hours: 48,
    access_duration_days: null,
    created_at: new Date(),
    updated_at: new Date(),
};

/** A `QuotaDeleteDeps` that never touches the DB - roles live in a plain in-memory array. */
function fakeDeps(initial: QuotaRoleRow[] = []) {
    const roles = [...initial];
    const removeCalls: Array<{ guildId: string; roleId: string }> = [];
    const deps: QuotaDeleteDeps = {
        getQuotaRoles: async () => roles,
        removeQuotaRole: async (guildId, roleId) => {
            removeCalls.push({ guildId, roleId });
            return `Quota role <@&${roleId}> removed. Members who already hold it keep it until it expires (Fixed mode) or is removed manually.`;
        },
    };
    return { deps, removeCalls };
}

function text(payload: ViewPayload): string {
    const flatten = (node: unknown): string[] => {
        if (node === null || typeof node !== "object") return [];
        const json = typeof (node as { toJSON?: unknown }).toJSON === "function" ? (node as { toJSON(): unknown }).toJSON() : node;
        if (Array.isArray(json)) return json.flatMap(flatten);
        const obj = json as { content?: string; components?: unknown; accessory?: unknown };
        return [obj.content ?? "", ...flatten(obj.components), ...flatten(obj.accessory)].filter(Boolean);
    };
    return [(payload as { content?: string }).content ?? "", ...flatten((payload as { components?: unknown }).components)].filter(Boolean).join("\n");
}

test("biomehunt.quota-delete: invalid typed number retries, then a valid one removes the right role", async () => {
    const { deps, removeCalls } = fakeDeps([ROLE_1, ROLE_2]);
    const fake = createFakeViewTransport();
    const resultP = fake.run(quotaDeleteView(deps), { guildId: GUILD_ID }, OWNER);
    await fake.flush();

    expect(text(fake.lastPayload())).toContain("1. <@&r1>");
    expect(text(fake.lastPayload())).toContain("2. <@&r2>");

    await fake.emit(fake.text(OWNER, "5"));
    expect(fake.notifies).toHaveLength(1);
    expect(fake.notifies[0].content).toBe("Please type a number between 1 and 2.");
    expect(removeCalls).toHaveLength(0);
    expect(text(fake.lastPayload())).toContain("1. <@&r1>"); // still on the list

    await fake.emit(fake.text(OWNER, "2"));
    expect(removeCalls).toEqual([{ guildId: GUILD_ID, roleId: "r2" }]);
    expect(text(fake.lastPayload())).toContain("removed");
    await resultP;
});

test("biomehunt.quota-delete: idling past the timeout shows \"Timed out, nothing removed.\"", async () => {
    const { deps, removeCalls } = fakeDeps([ROLE_1]);
    const fake = createFakeViewTransport();
    const resultP = fake.run(quotaDeleteView(deps), { guildId: GUILD_ID }, OWNER);
    await fake.flush();

    await fake.clock.advance(settings.ui.quotaReplyTimeoutMs);

    await resultP;
    expect(removeCalls).toHaveLength(0);
    expect(text(fake.lastPayload())).toContain("Timed out, nothing removed.");
});

test("biomehunt.quota-delete: another user's typed text is ignored", async () => {
    const { deps, removeCalls } = fakeDeps([ROLE_1]);
    const fake = createFakeViewTransport();
    void fake.run(quotaDeleteView(deps), { guildId: GUILD_ID }, OWNER);
    await fake.flush();

    await fake.emit(fake.text(OTHER, "1"));

    expect(removeCalls).toHaveLength(0);
    expect(fake.notifies).toHaveLength(0);
    expect(text(fake.lastPayload())).toContain("1. <@&r1>"); // still on the list, untouched
});

test("biomehunt.quota-delete: no quota roles configured shows the info message immediately, no prompt", async () => {
    const { deps } = fakeDeps([]);
    const fake = createFakeViewTransport();
    const resultP = fake.run(quotaDeleteView(deps), { guildId: GUILD_ID }, OWNER);
    await fake.flush();

    expect(await resultP).toBeUndefined();
    expect(text(fake.lastPayload())).toContain("No quota roles configured yet.");
});
