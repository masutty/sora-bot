import { expect, test } from "bun:test";
import type { GuildMember } from "discord.js";
import { createFakeViewTransport, type ViewPayload } from "@/define";
import { getAwardableBadges } from "../constants/badges.constants";
import type { ResetTotals } from "../services/member.service";
import type { ActivitySessionRow, UserRow } from "../types";
import { type MemberAdminDeps, type MemberAdminSnapshot, memberAdminView } from "./member-admin.view";
import type { ProfileData } from "./stats-builders";

const OWNER = "owner";

type Json = {
    custom_id?: string;
    label?: string;
    disabled?: boolean;
    content?: string;
    components?: Json[];
    accessory?: Json;
    options?: Array<{ label: string; description?: string; value: string }>;
    max_values?: number;
    min_values?: number;
};

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
const labels = (payload: ViewPayload) => flatten(payload).flatMap((c) => (c.label ? [c.label] : []));
const comp = (payload: ViewPayload, key: string): Json => {
    const found = flatten(payload).find((c) => c.custom_id?.endsWith(`:${key}`));
    if (!found) throw new Error(`No component "${key}"`);
    return found;
};

const member = {
    id: "u1",
    user: { username: "truebnuy" },
    displayAvatarURL: () => "https://example.com/a.png",
} as unknown as GuildMember;

const user = (over: Partial<UserRow> = {}): UserRow => ({
    id: 1,
    guild_id: "g1",
    discord_user_id: "u1",
    current_status: "idle",
    last_activity_at: null,
    activity_grace_until: null,
    activity_grace_biome: null,
    paused_at: null,
    created_at: new Date("2026-09-03T00:00:00Z"),
    seeds: 1240,
    xp: 6340,
    flower: null,
    ...over,
});

const sessions = (count: number): ActivitySessionRow[] =>
    Array.from({ length: count }, (_, i) => ({
        id: 4821 - i,
        user_id: 1,
        started_at: new Date("2026-10-18T05:02:00Z"),
        ended_at: new Date("2026-10-18T07:15:00Z"),
        duration_seconds: 7980,
    }));

const profile = (over: Partial<ProfileData> = {}): ProfileData => ({
    user: user(),
    activeSeconds: 0,
    activeSecondsToday: 0,
    quotaDayStart: new Date(),
    quotaDayEnd: new Date(),
    biomes: [{ biome: "GLITCHED", count: 2 }],
    channelId: "c1",
    flower: null,
    quotaSummaryLines: [],
    badges: [{ user_id: 1, badge: "GLITCHED", awarded_at: new Date("2026-10-15T00:00:00Z") }],
    sessions: sessions(12),
    flowersEnabled: false,
    economyEnabled: true,
    ...over,
});

const snapshot = (over: Partial<MemberAdminSnapshot> = {}): MemberAdminSnapshot => ({
    data: profile(),
    channel: { channelId: "c1", createdAt: new Date("2026-09-03T00:00:00Z"), webhookWorking: true },
    autoDelete: true,
    deleteAfterS: 48 * 3600,
    badgeRoles: { GLITCHED: "r1" },
    ...over,
});

const PREVIEW: ResetTotals = { sessions: 38, finds: 22, badges: 3, seeds: 1240, xp: 6340 };

function fakeDeps(world: { snap: MemberAdminSnapshot; preview?: ResetTotals; canAssign?: boolean }) {
    const calls: unknown[][] = [];
    const rec =
        <T>(name: string, ret?: T) =>
        async (...args: unknown[]) => {
            calls.push([name, ...args]);
            return ret as T;
        };
    const deps: MemberAdminDeps = {
        load: async () => structuredClone(world.snap),
        pause: rec("pause"),
        unpause: rec("unpause"),
        grant: rec("grant"),
        setup: rec("setup", "Setup complete."),
        adopt: rec("adopt", "Adopted."),
        channelName: () => "truebnuy-old",
        unlink: rec("unlink"),
        resetPreview: async () => world.preview ?? PREVIEW,
        reset: rec("reset", PREVIEW),
        deleteEverything: rec("deleteEverything"),
        adjustBiome: rec("adjustBiome"),
        setBiomeCount: rec("setBiomeCount"),
        giveBadge: rec("giveBadge"),
        takeBadge: rec("takeBadge"),
        canAssignRole: () => world.canAssign ?? true,
        sessionTotal: async () => 38,
        deleteSessions: rec("deleteSessions", 2),
        clearSessions: rec("clearSessions", 38),
    };
    return { deps, calls };
}

async function open(snap: MemberAdminSnapshot = snapshot(), extra: { preview?: ResetTotals; canAssign?: boolean } = {}) {
    const world = { snap, ...extra };
    const { deps, calls } = fakeDeps(world);
    const fake = createFakeViewTransport();
    void fake.run(memberAdminView(member, deps), undefined, OWNER);
    await fake.flush();
    return { fake, calls, world };
}

type Fake = Awaited<ReturnType<typeof open>>["fake"];

async function submitForm(fake: Fake, key: string, values: Record<string, string>) {
    const ack = fake.modalSubmit(OWNER);
    fake.modalResult = async () => ({ values, ack });
    await fake.emit(fake.click(key, OWNER));
}

test("profile tab shows the Admin box", async () => {
    const { fake } = await open();
    const t = text(fake.lastPayload());
    expect(t).toContain("`truebnuy`'s Profile");
    expect(t).toContain("**Admin**");
    expect(t).toContain("**Macro channel**\n<#c1> · webhook working");
    expect(t).toContain("**Auto-delete**\nDeletes the channel 48h after they go inactive.");
    expect(t).toContain("**Seeds & XP**\n`1,240 🌱` · `6,340 XP`");
    expect(t).toContain("**Danger zone**\nReset or delete this member's data.");
    expect(labels(fake.lastPayload())).toEqual(
        expect.arrayContaining(["Manage", "Pause", "Adjust", "Open", "Profile", "Biomes", "Badges", "Sessions"]),
    );
    expect(labels(fake.lastPayload())).not.toContain("Quotas");
});

test("pause row hidden while AUTO_DELETE_ENABLED is off", async () => {
    const { fake } = await open(snapshot({ autoDelete: false }));
    expect(text(fake.lastPayload())).not.toContain("Auto-delete");
    expect(labels(fake.lastPayload())).not.toContain("Pause");
});

test("pause flips to Resume", async () => {
    const world = { snap: snapshot() };
    const { deps, calls } = fakeDeps(world);
    const fake = createFakeViewTransport();
    void fake.run(memberAdminView(member, deps), undefined, OWNER);
    await fake.flush();
    world.snap = snapshot({ data: profile({ user: user({ paused_at: new Date() }) }) });
    await fake.emit(fake.click("pause", OWNER));
    expect(calls).toEqual([["pause"]]);
    expect(text(fake.lastPayload())).toContain("**Auto-delete** · paused\nTheir channel is never auto-deleted.");
    expect(labels(fake.lastPayload())).toContain("Resume");
});

test('adjust form refuses "abc"', async () => {
    const { fake, calls } = await open();
    await submitForm(fake, "adjust", { seeds: "abc", xp: "" });
    const spec = fake.modals.at(-1)?.spec;
    expect(spec?.fields.map((f) => f.label)).toEqual(["Seeds to add (now 1,240)", "XP to add (now 6,340)"]);
    expect(fake.notifies.at(-1)?.content).toContain("Seeds to add isn't a whole number");
    expect(calls).toEqual([]);
});

test("adjust form grants the amounts", async () => {
    const { fake, calls } = await open();
    await submitForm(fake, "adjust", { seeds: "-200", xp: "" });
    expect(calls).toEqual([["grant", -200, 0]]);
});

test("recreate asks DM or not, and cancel does nothing", async () => {
    const { fake, calls } = await open();
    await fake.emit(fake.click("manage", OWNER));
    expect(text(fake.lastPayload())).toContain("- Webhook: working");
    await fake.emit(fake.click("recreate", OWNER));
    expect(labels(fake.lastPayload())).toEqual(["Recreate and DM them", "Recreate only", "Cancel"]);
    await fake.emit(fake.click("cancel", OWNER));
    expect(calls).toEqual([]);

    await fake.emit(fake.click("manage", OWNER));
    await fake.emit(fake.click("recreate", OWNER));
    await fake.emit(fake.click("dm", OWNER));
    expect(calls).toEqual([["setup", true]]);
    expect(fake.notifies.at(-1)?.content).toBe("Setup complete.");
});

test("existing channel: pick, then the webhook form", async () => {
    const { fake, calls } = await open();
    await fake.emit(fake.click("manage", OWNER));
    await fake.emit(fake.click("existing", OWNER));
    const ack = fake.modalSubmit(OWNER);
    fake.modalResult = async () => ({ values: { url: " https://discord.com/api/webhooks/1/x " }, ack });
    await fake.emit(fake.click("existingChannel", OWNER, ["c9"]));
    expect(fake.modals.at(-1)?.spec.title).toBe("Webhook for #truebnuy-old");
    expect(calls).toEqual([["adopt", "c9", "https://discord.com/api/webhooks/1/x"]]);
});

test("no-profile screen has the three setup buttons", async () => {
    const { fake, calls } = await open(snapshot({ data: null, channel: null }));
    const t = text(fake.lastPayload());
    expect(t).toContain("`truebnuy` has no profile");
    expect(labels(fake.lastPayload())).toEqual(["Set up and DM them", "Set up only", "Use an existing channel"]);
    await fake.emit(fake.click("setupOnly", OWNER));
    expect(calls).toEqual([["setup", false]]);
});

test("biomes tab lists counts in a select; the editor changes counts", async () => {
    const { fake, calls } = await open();
    await fake.emit(fake.click("tab:biomes", OWNER));
    const select = comp(fake.lastPayload(), "pickBiome");
    expect(select.options?.[0]).toMatchObject({ label: "Glitched", value: "GLITCHED" });
    expect(select.options?.[0]?.description).toContain("2 found");
    expect(select.options?.some((o) => o.description?.includes("none yet"))).toBe(true);

    await fake.emit(fake.click("pickBiome", OWNER, ["GLITCHED"]));
    expect(text(fake.lastPayload())).toContain("Found `2` times");
    expect(text(fake.lastPayload())).toContain("Changes here don't give Seeds, XP or badges.");
    await fake.emit(fake.click("biomeInc", OWNER));
    await fake.emit(fake.click("biomeDec", OWNER));
    await submitForm(fake, "biomeSet", { count: "5" });
    await submitForm(fake, "biomeSet", { count: "x" });
    expect(calls).toEqual([
        ["adjustBiome", "GLITCHED", 1],
        ["adjustBiome", "GLITCHED", -1],
        ["setBiomeCount", "GLITCHED", 5],
    ]);

    await fake.emit(fake.click("back", OWNER));
    expect(comp(fake.lastPayload(), "pickBiome")).toBeDefined();
});

test("remove all confirm has the badge note", async () => {
    const { fake, calls } = await open();
    await fake.emit(fake.click("tab:biomes", OWNER));
    await fake.emit(fake.click("pickBiome", OWNER, ["GLITCHED"]));
    await fake.emit(fake.click("biomeClear", OWNER));
    const t = text(fake.lastPayload());
    expect(t).toContain("Remove all 2 Glitched finds?");
    expect(t).toContain("-# The Glitched badge stays. To take it too, use the Badges tab.");
    expect(calls).toEqual([]);
    await fake.emit(fake.click("yes", OWNER));
    expect(calls).toEqual([["setBiomeCount", "GLITCHED", 0]]);
});

test("take asks first, give doesn't", async () => {
    const { fake, calls } = await open();
    await fake.emit(fake.click("tab:badges", OWNER));
    const t = text(fake.lastPayload());
    expect(t).toContain(`1 of ${getAwardableBadges().length} earned.`);
    expect(labels(fake.lastPayload()).filter((l) => l === "Take" || l === "Give")).toHaveLength(Math.min(5, getAwardableBadges().length));

    const slot = (label: string) =>
        flatten(fake.lastPayload())
            .find((c) => c.label === label)
            ?.custom_id?.split(":")
            .slice(-2)
            .join(":") as string;

    await fake.emit(fake.click(slot("Give"), OWNER));
    expect(calls).toEqual([["giveBadge", expect.any(String)]]);

    calls.length = 0;
    await fake.emit(fake.click(slot("Take"), OWNER));
    expect(calls).toEqual([]);
    expect(text(fake.lastPayload())).toContain("Take this badge?");
    expect(text(fake.lastPayload())).toContain("They also lose the <@&r1> role.");
    await fake.emit(fake.click("yes", OWNER));
    expect(calls).toEqual([["takeBadge", "GLITCHED"]]);
});

test("delete sessions confirm has the quota note", async () => {
    const { fake, calls } = await open();
    await fake.emit(fake.click("tab:sessions", OWNER));
    const select = comp(fake.lastPayload(), "deleteSessions");
    expect(select.min_values).toBe(1);
    expect(select.max_values).toBe(10);
    expect(select.options?.[0]).toMatchObject({ label: "#4821 · 2h 13m", description: "Oct 18, 05:02 - 07:15" });

    await fake.emit(fake.click("deleteSessions", OWNER, ["4821", "4820"]));
    const t = text(fake.lastPayload());
    expect(t).toContain("Delete 2 sessions?");
    expect(t).toContain("`#4821` · `2h 13m`");
    expect(t).toContain("-# If these sessions are recent, deleting them may affect their quotas.");
    await fake.emit(fake.click("yes", OWNER));
    expect(calls).toEqual([["deleteSessions", [4821, 4820]]]);
});

test("clear all confirms with the total", async () => {
    const { fake, calls } = await open();
    await fake.emit(fake.click("tab:sessions", OWNER));
    await fake.emit(fake.click("clearSessions", OWNER));
    expect(text(fake.lastPayload())).toContain("Delete all 38 sessions?");
    await fake.emit(fake.click("yes", OWNER));
    expect(calls).toEqual([["clearSessions"]]);
});

test('empty sessions tab says "No activity recorded yet."', async () => {
    const { fake } = await open(snapshot({ data: profile({ sessions: [] }) }));
    await fake.emit(fake.click("tab:sessions", OWNER));
    expect(text(fake.lastPayload())).toContain("No activity recorded yet.");
    expect(labels(fake.lastPayload())).not.toContain("Clear all");
});

test("danger zone lists the three actions with their short lines", async () => {
    const { fake } = await open();
    await fake.emit(fake.click("danger", OWNER));
    const t = text(fake.lastPayload());
    expect(t).toContain("**Unlink member**\n-# Removes the channel, keeps the data.");
    expect(t).toContain("**Reset member**\n-# Wipes their progress, keeps the channel.");
    expect(t).toContain("**Delete everything**\n-# Removes their whole profile.");
});

test("danger form needs the exact username", async () => {
    const { fake, calls } = await open();
    await fake.emit(fake.click("danger", OWNER));
    await submitForm(fake, "unlink", { confirm: "someone" });
    const spec = fake.modals.at(-1)?.spec;
    expect(spec?.title).toBe("Unlink member: truebnuy");
    expect(spec?.text).toContain("Deletes their macro channel.");
    expect(spec?.fields[0]?.label).toBe("Type truebnuy to confirm");
    expect(fake.notifies.at(-1)?.content).toContain("Nothing was done");
    expect(calls).toEqual([]);

    await submitForm(fake, "unlink", { confirm: "truebnuy" });
    expect(calls).toEqual([["unlink"]]);
});

test("reset form shows fresh totals", async () => {
    const { fake, calls, world } = await open();
    await fake.emit(fake.click("danger", OWNER));
    await submitForm(fake, "reset", { confirm: "no" });
    expect(fake.modals.at(-1)?.spec.text).toContain("Gone: 38 sessions, 22 biome finds, 3 badges, `1,240 🌱`, `6,340 XP`.");

    world.preview = { sessions: 1, finds: 1, badges: 0, seeds: 5, xp: 0 };
    await submitForm(fake, "reset", { confirm: "truebnuy" });
    expect(fake.modals.at(-1)?.spec.text).toContain("Gone: 1 session, 1 biome find, 0 badges, `5 🌱`, `0 XP`.");
    expect(calls).toEqual([["reset"]]);
});

test("delete everything runs only on the exact name", async () => {
    const { fake, calls } = await open();
    await fake.emit(fake.click("danger", OWNER));
    await submitForm(fake, "deleteAll", { confirm: "truebnuy" });
    expect(fake.modals.at(-1)?.spec.text).toContain("Deletes their whole profile here, macro channel included.");
    expect(calls).toEqual([["deleteEverything"]]);
});
