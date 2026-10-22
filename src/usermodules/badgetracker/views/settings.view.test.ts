import { expect, test } from "bun:test";
import { createFakeViewTransport, type ViewPayload } from "@/define";
import type { PostStatus } from "../services/post-status";
import type { BadgePreview, TrackerConfig, TrackerOverview } from "../services/tracker-config.service";
import { BadgeTrackerError, type GuildBadgeRow } from "../types";
import { renderOverviewReadOnly } from "./settings.screens";
import { type TrackerViewDeps, trackerSettingsView } from "./settings.view";

const OWNER = "owner";
const GUILD = "g1";

type Json = {
    custom_id?: string;
    label?: string;
    content?: string;
    components?: Json[];
    accessory?: Json;
    default_values?: { id: string }[];
    min_values?: number;
    max_values?: number;
    media?: { url: string };
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
const keys = (payload: ViewPayload) => flatten(payload).flatMap((c) => (c.custom_id ? [c.custom_id.split(":").slice(2).join(":")] : []));
const labels = (payload: ViewPayload) => flatten(payload).flatMap((c) => (c.label ? [c.label] : []));
const component = (payload: ViewPayload, key: string) => flatten(payload).find((c) => c.custom_id?.split(":").slice(2).join(":") === key);

const badge = (id: string, name: string, extra: Partial<GuildBadgeRow> = {}): GuildBadgeRow => ({
    guild_id: GUILD,
    badge_id: id,
    ping_role_id: null,
    custom_description: null,
    name,
    description: "Found the world.",
    icon_url: null,
    awarded_count: "48216",
    deleted: false,
    ...extra,
});

const preview = (id = "900", name = "Fresh Badge"): BadgePreview => ({
    badge: { id, name, description: "Brand new.", awardedCount: 48213 },
    iconUrl: "https://img/x.png",
});

interface Setup {
    badges?: GuildBadgeRow[];
    channelId?: string | null;
    minutes?: number;
    status?: PostStatus;
    mentionable?: boolean;
    previewError?: string;
}

function fakeDeps(setup: Setup = {}) {
    const calls: unknown[][] = [];
    const data = { badges: [...(setup.badges ?? [])], channelId: setup.channelId ?? null, minutes: setup.minutes ?? 5 };
    const overview = async (): Promise<TrackerOverview> => ({
        channelId: data.channelId,
        intervalMinutes: data.minutes,
        badges: data.badges,
    });
    const config: TrackerConfig = {
        previewBadge: async (_g, raw) => {
            calls.push(["previewBadge", raw]);
            if (setup.previewError) throw new BadgeTrackerError(setup.previewError);
            return preview();
        },
        trackBadge: async (_g, p, roleId) => {
            calls.push(["trackBadge", p.badge.id, roleId]);
            data.badges = [...data.badges, badge(p.badge.id, p.badge.name, { ping_role_id: roleId })];
        },
        removeBadge: async (_g, raw) => {
            calls.push(["removeBadge", raw]);
            const row = data.badges.find((b) => b.badge_id === raw);
            data.badges = data.badges.filter((b) => b.badge_id !== raw);
            return row?.name ?? "";
        },
        setChannel: async (_g, channelId) => {
            calls.push(["setChannel", channelId]);
            data.channelId = channelId;
        },
        setPingRole: async (_g, raw, roleId) => {
            calls.push(["setPingRole", raw, roleId]);
            data.badges = data.badges.map((b) => (b.badge_id === raw ? { ...b, ping_role_id: roleId } : b));
            return "";
        },
        setDescription: async (_g, raw, desc) => {
            calls.push(["setDescription", raw, desc]);
            data.badges = data.badges.map((b) => (b.badge_id === raw ? { ...b, custom_description: desc } : b));
            return "";
        },
        setIntervalMinutes: async (minutes) => {
            calls.push(["setIntervalMinutes", minutes]);
            if (minutes < 1 || minutes > 60) throw new BadgeTrackerError("The interval must be between 1 and 60 minutes.");
            data.minutes = minutes;
        },
        getOverview: overview,
    };
    const deps: TrackerViewDeps = {
        guildId: GUILD,
        config,
        postStatus: () => setup.status ?? "ok",
        canMention: () => setup.mentionable ?? true,
    };
    return { deps, calls, data };
}

async function open(setup: Setup = {}) {
    const { deps, calls, data } = fakeDeps(setup);
    const fake = createFakeViewTransport();
    void fake.run(trackerSettingsView(deps), undefined, OWNER);
    await fake.flush();
    return { fake, calls, data };
}

async function submitForm(fake: Awaited<ReturnType<typeof open>>["fake"], key: string, values: Record<string, string>) {
    const ack = fake.modalSubmit(OWNER);
    fake.modalResult = async () => ({ values, ack });
    await fake.emit(fake.click(key, OWNER));
}

const seven = () => [
    badge("1", "Glitch Hunter", { ping_role_id: "r1" }),
    badge("2", "Dreamspace Visitor"),
    badge("3", "Cyberspace", { deleted: true, ping_role_id: "r2" }),
    badge("4", "Four"),
    badge("5", "Five"),
    badge("6", "Six"),
    badge("7", "Seven"),
];

test("overview matches the mock copy", async () => {
    const { fake } = await open({ badges: seven(), channelId: "c1", minutes: 5 });
    const t = text(fake.lastPayload());
    expect(t).toContain("**Badge Tracker**\nPosts in the channel below when a tracked badge gets new awards.");
    expect(t).toContain("**Channel**");
    expect(t).toContain("**Check interval**\nEvery 5 minutes, for all servers");
    expect(t).toContain("**Badges** (7 of 25)");
    expect(t).toContain("**Glitch Hunter**\n-# 1 · pings <@&r1>");
    expect(t).toContain("**Dreamspace Visitor**\n-# 2 · no ping");
    expect(t).toContain("**Cyberspace**\n-# 3 · ⚠️ deleted on Roblox");
    expect(t).not.toContain("**Six**");
    expect(component(fake.lastPayload(), "channel")?.default_values?.[0]?.id).toBe("c1");
    expect(component(fake.lastPayload(), "channel")?.min_values).toBe(0);
    expect(labels(fake.lastPayload())).toEqual(expect.arrayContaining(["Change", "Add badge", "Edit", "1 / 2"]));
});

test("pagination shows only with more than five badges", async () => {
    const few = await open({ badges: seven().slice(0, 5) });
    expect(keys(few.fake.lastPayload())).not.toContain("next");
    const many = await open({ badges: seven() });
    expect(keys(many.fake.lastPayload())).toContain("next");
});

test("first run shows the empty copy and no pagination", async () => {
    const { fake } = await open();
    const t = text(fake.lastPayload());
    expect(t).toContain("**Badges**\nNo badges yet. Add one with its ID or its Roblox link.");
    expect(t).not.toContain("of 25");
    expect(keys(fake.lastPayload())).not.toContain("next");
});

test("no_permission adds the warning", async () => {
    const { fake } = await open({ channelId: "c1", status: "no_permission" });
    expect(text(fake.lastPayload())).toContain("⚠️ I can't post in <#c1>. Updates are paused until I can send messages there.");
    const ok = await open({ channelId: "c1", status: "ok" });
    expect(text(ok.fake.lastPayload())).not.toContain("I can't post");
});

test("the channel select saves and reloads", async () => {
    const { fake, calls } = await open();
    await fake.emit(fake.click("channel", OWNER, ["c9"]));
    expect(calls).toEqual([["setChannel", "c9"]]);
    expect(component(fake.lastPayload(), "channel")?.default_values?.[0]?.id).toBe("c9");
});

test("add flow: modal, preview copy, pick a role, track", async () => {
    const { fake, calls } = await open();
    await submitForm(fake, "add", { badge: "https://www.roblox.com/badges/900" });
    const spec = fake.modals.at(-1)?.spec;
    expect(spec?.title).toBe("Track a badge");
    expect(spec?.fields[0]).toMatchObject({
        key: "badge",
        label: "Badge ID or link",
        placeholder: "2124445684 or https://www.roblox.com/badges/…",
    });
    expect(calls).toEqual([["previewBadge", "https://www.roblox.com/badges/900"]]);
    const t = text(fake.lastPayload());
    expect(t).toContain(
        "## Fresh Badge\n-# Brand new.\nAwarded 48,213 times\n-# ID 900 · [View on Roblox](https://www.roblox.com/badges/900)",
    );
    expect(t).toContain("Who gets pinged when it's awarded?");
    expect(labels(fake.lastPayload())).toEqual(expect.arrayContaining(["Track badge", "Cancel"]));

    await fake.emit(fake.click("previewRole", OWNER, ["r5"]));
    expect(component(fake.lastPayload(), "previewRole")?.default_values?.[0]?.id).toBe("r5");
    await fake.emit(fake.click("track", OWNER));
    expect(calls.at(-1)).toEqual(["trackBadge", "900", "r5"]);
    expect(text(fake.lastPayload())).toContain("**Fresh Badge**\n-# 900 · pings <@&r5>");
    expect(text(fake.lastPayload())).toContain("**Badges** (1 of 25)");
});

test("cancel returns to the overview without saving", async () => {
    const { fake, calls } = await open();
    await submitForm(fake, "add", { badge: "900" });
    await fake.emit(fake.click("cancel", OWNER));
    expect(calls.map((c) => c[0])).toEqual(["previewBadge"]);
    expect(text(fake.lastPayload())).toContain("No badges yet.");
});

test("a preview error notifies and keeps the overview", async () => {
    const { fake } = await open({ previewError: "There's no badge with ID `900` on Roblox." });
    await submitForm(fake, "add", { badge: "900" });
    expect(fake.notifies.at(-1)?.content).toBe("There's no badge with ID `900` on Roblox.");
    expect(text(fake.lastPayload())).toContain("**Badge Tracker**");
    expect(keys(fake.lastPayload())).toContain("add");
});

test("the preview role refuses a role the bot cannot ping", async () => {
    const { fake, calls } = await open({ mentionable: false });
    await submitForm(fake, "add", { badge: "900" });
    await fake.emit(fake.click("previewRole", OWNER, ["r5"]));
    expect(fake.notifies.at(-1)?.content).toBe("I can't ping <@&r5>. Make it mentionable or give me the Mention Everyone permission.");
    expect(component(fake.lastPayload(), "previewRole")?.default_values).toBeUndefined();
    await fake.emit(fake.click("track", OWNER));
    expect(calls.at(-1)).toEqual(["trackBadge", "900", null]);
});

test("edit:1 on page 2 opens the badge at index 6", async () => {
    const { fake } = await open({ badges: seven() });
    await fake.emit(fake.click("next", OWNER));
    expect(text(fake.lastPayload())).toContain("**Six**");
    await fake.emit(fake.click("edit:1", OWNER));
    expect(text(fake.lastPayload())).toContain("## Seven");
});

test("editor: custom description label only when one is set", async () => {
    const plain = await open({ badges: [badge("1", "A")] });
    await plain.fake.emit(plain.fake.click("edit:0", OWNER));
    let t = text(plain.fake.lastPayload());
    expect(t).toContain("## A\nAwarded 48,216 times\n-# ID 1 · [View on Roblox](https://www.roblox.com/badges/1)");
    expect(t).toContain("**Description**\nFound the world.");
    expect(t).not.toContain("(custom)");
    expect(t).toContain("**Ping role**");

    const custom = await open({ badges: [badge("1", "A", { custom_description: "Mine." })] });
    await custom.fake.emit(custom.fake.click("edit:0", OWNER));
    t = text(custom.fake.lastPayload());
    expect(t).toContain("**Description** (custom)\nMine.");
});

test("editor: deleted badge shows the warning and no Roblox link", async () => {
    const { fake } = await open({ badges: [badge("3", "Old", { deleted: true })] });
    await fake.emit(fake.click("edit:0", OWNER));
    const t = text(fake.lastPayload());
    expect(t).toContain("⚠️ This badge was deleted on Roblox, so it's no longer checked.");
    expect(t).not.toContain("View on Roblox");
    expect(keys(fake.lastPayload())).not.toContain("editRole");
    expect(labels(fake.lastPayload())).toEqual(expect.arrayContaining(["Back", "Remove"]));
});

test("editor role select saves, clears, and refuses an unmentionable role", async () => {
    const { fake, calls } = await open({ badges: [badge("1", "A", { ping_role_id: "r1" })] });
    await fake.emit(fake.click("edit:0", OWNER));
    expect(component(fake.lastPayload(), "editRole")?.default_values?.[0]?.id).toBe("r1");
    await fake.emit(fake.click("editRole", OWNER, ["r2"]));
    await fake.emit(fake.click("editRole", OWNER, []));
    expect(calls).toEqual([
        ["setPingRole", "1", "r2"],
        ["setPingRole", "1", null],
    ]);

    const blocked = await open({ badges: [badge("1", "A")], mentionable: false });
    await blocked.fake.emit(blocked.fake.click("edit:0", OWNER));
    await blocked.fake.emit(blocked.fake.click("editRole", OWNER, ["r2"]));
    expect(blocked.calls).toHaveLength(0);
    expect(blocked.fake.notifies.at(-1)?.content).toContain("I can't ping <@&r2>.");
});

test("description form is prefilled, shows Roblox's text and saves", async () => {
    const { fake, calls } = await open({ badges: [badge("1", "A", { custom_description: "Mine." })] });
    await fake.emit(fake.click("edit:0", OWNER));
    await submitForm(fake, "editDescription", { description: "  New text  " });
    const spec = fake.modals.at(-1)?.spec;
    expect(spec?.title).toBe("Description for A");
    expect(spec?.text).toBe("Roblox's description: *Found the world.*");
    expect(spec?.fields[0]).toMatchObject({
        key: "description",
        label: "Description (empty = Roblox's)",
        style: "paragraph",
        maxLength: 300,
        value: "Mine.",
    });
    expect(calls).toEqual([["setDescription", "1", "  New text  "]]);
    expect(text(fake.lastPayload())).toContain("**Description** (custom)\nNew text");
});

test("an empty description form clears the custom text", async () => {
    const { fake, calls } = await open({ badges: [badge("1", "A", { custom_description: "Mine." })] });
    await fake.emit(fake.click("edit:0", OWNER));
    await submitForm(fake, "editDescription", { description: "" });
    expect(calls).toEqual([["setDescription", "1", null]]);
});

test("the description modal title is cut to 45 characters", async () => {
    const { fake } = await open({ badges: [badge("1", "A very long badge name that goes on and on forever")] });
    await fake.emit(fake.click("edit:0", OWNER));
    await submitForm(fake, "editDescription", { description: "x" });
    expect(fake.modals.at(-1)?.spec.title.length).toBeLessThanOrEqual(45);
});

test("remove: confirm then back to the overview without the badge", async () => {
    const { fake, calls } = await open({ badges: [badge("1", "A"), badge("2", "B")] });
    await fake.emit(fake.click("edit:0", OWNER));
    await fake.emit(fake.click("remove", OWNER));
    expect(text(fake.lastPayload())).toContain("**Stop tracking this badge?**\nA");
    expect(labels(fake.lastPayload())).toEqual(expect.arrayContaining(["Remove", "Cancel"]));
    await fake.emit(fake.click("yes", OWNER));
    expect(calls).toEqual([["removeBadge", "1"]]);
    const t = text(fake.lastPayload());
    expect(t).toContain("**Badges** (1 of 25)");
    expect(t).not.toContain("**A**");
});

test("remove: Cancel goes back to the editor", async () => {
    const { fake, calls } = await open({ badges: [badge("1", "A")] });
    await fake.emit(fake.click("edit:0", OWNER));
    await fake.emit(fake.click("remove", OWNER));
    await fake.emit(fake.click("no", OWNER));
    expect(calls).toHaveLength(0);
    expect(text(fake.lastPayload())).toContain("## A");
});

test("back returns to the overview", async () => {
    const { fake } = await open({ badges: [badge("1", "A")] });
    await fake.emit(fake.click("edit:0", OWNER));
    await fake.emit(fake.click("back", OWNER));
    expect(text(fake.lastPayload())).toContain("**Badge Tracker**");
});

test("interval form is prefilled and saves", async () => {
    const { fake, calls } = await open({ minutes: 7 });
    await submitForm(fake, "interval", { minutes: "10" });
    const spec = fake.modals.at(-1)?.spec;
    expect(spec?.title).toBe("Check interval");
    expect(spec?.text).toBe("How often every tracked badge is checked. This applies to all servers.");
    expect(spec?.fields[0]).toMatchObject({ key: "minutes", label: "Minutes (1-60)", value: "7" });
    expect(calls).toEqual([["setIntervalMinutes", 10]]);
    expect(text(fake.lastPayload())).toContain("Every 10 minutes, for all servers");
});

test("an interval of 0 notifies and keeps the old value", async () => {
    const { fake } = await open({ minutes: 7 });
    await submitForm(fake, "interval", { minutes: "0" });
    expect(fake.notifies.at(-1)?.content).toBe("The interval must be between 1 and 60 minutes.");
    expect(text(fake.lastPayload())).toContain("Every 7 minutes, for all servers");
});

test("the read-only overview lists the badges with no controls", () => {
    const reply = renderOverviewReadOnly(
        { channelId: "c1", intervalMinutes: 1, badges: [badge("1", "A", { ping_role_id: "r1" }), badge("2", "B")] },
        "no_permission",
    );
    const t = text({ components: reply.components } as ViewPayload);
    expect(t).toContain("<#c1>");
    expect(t).toContain("Every 1 minute, for all servers");
    expect(t).toContain("**A**\n-# 1 · pings <@&r1>");
    expect(t).toContain("I can't post in <#c1>");
    expect(keys({ components: reply.components } as ViewPayload)).toEqual([]);
    expect(reply.allowedMentions).toEqual({ parse: [] });
});
