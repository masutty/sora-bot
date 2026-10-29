import { expect, test } from "bun:test";
import { ButtonStyle } from "discord.js";
import { createFakeViewTransport, type ViewPayload } from "@/define";
import type { LeaderboardMetric, LeaderboardPeriod, LeaderboardRow } from "../repository/leaderboard.repository";
import { formatHoursMinutes, type LeaderboardDeps, leaderboardView } from "./leaderboard.view";

const VIEWER = "u7";

type Json = {
    custom_id?: string;
    label?: string;
    style?: number;
    disabled?: boolean;
    content?: string;
    options?: Array<{ label: string; value: string; default?: boolean }>;
    components?: Json[];
    accessory?: Json;
};

/** Every component on the message, as plain JSON, depth-first - same local test glue as flags.view.test.ts. */
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

const find = (payload: ViewPayload, key: string) => flatten(payload).find((c) => c.custom_id?.endsWith(`:${key}`));

const members = (count: number, value = (i: number) => 100 - i): LeaderboardRow[] =>
    Array.from({ length: count }, (_, i) => ({ discordUserId: `u${i + 1}`, value: value(i) }));

/** Deps that never touch the DB - they answer from `data` and record what was loaded. */
function fakeDeps(data: Partial<Record<LeaderboardMetric, LeaderboardRow[]>> = {}) {
    const loads: Array<[LeaderboardMetric, LeaderboardPeriod]> = [];
    const deps: LeaderboardDeps = {
        load: async (metric, period) => {
            loads.push([metric, period]);
            return data[metric] ?? [];
        },
    };
    return { deps, loads };
}

async function open(rows: LeaderboardRow[], opts: { economy?: boolean; data?: Partial<Record<LeaderboardMetric, LeaderboardRow[]>> } = {}) {
    const { deps, loads } = fakeDeps(opts.data);
    const fake = createFakeViewTransport();
    void fake.run(leaderboardView(deps), { viewerId: VIEWER, economy: opts.economy ?? true, rows }, VIEWER);
    await fake.flush();
    return { fake, loads };
}

test("leaderboard: opens on Rares, last 7 days, with medals then numbers", async () => {
    const { fake } = await open(members(5));
    const t = text(fake.lastPayload());
    expect(t).toContain("## Leaderboard\nRares · Last 7 days");
    expect(t).toContain("🥇 <@u1> · `100`");
    expect(t).toContain("🥈 <@u2> · `99`");
    expect(t).toContain("🥉 <@u3> · `98`");
    expect(t).toContain("`#4` <@u4> · `97`");
});

test("leaderboard: Hours as a duration and Seeds with separators", async () => {
    const { fake } = await open(members(1), {
        data: { hours: [{ discordUserId: "u1", value: 52_200 }], seeds: [{ discordUserId: "u1", value: 1234 }] },
    });
    await fake.emit(fake.click("metric:hours", VIEWER));
    expect(text(fake.lastPayload())).toContain("Hours · Last 7 days");
    expect(text(fake.lastPayload())).toContain("<@u1> · `14h 30m`");
    await fake.emit(fake.click("metric:seeds", VIEWER));
    expect(text(fake.lastPayload())).toContain("<@u1> · `1,234 🌱`");
});

test("leaderboard: formats macro time", () => {
    expect(formatHoursMinutes(52_200)).toBe("14h 30m");
    expect(formatHoursMinutes(2_700)).toBe("45m");
    expect(formatHoursMinutes(3_600)).toBe("1h 0m");
});

test("leaderboard: the viewer's line shows only when ranked", async () => {
    const ranked = await open(members(8));
    expect(text(ranked.fake.lastPayload())).toContain("You're #7 · `94`");

    const unranked = await open(members(3));
    expect(text(unranked.fake.lastPayload())).not.toContain("You're");
});

test("leaderboard: empty state", async () => {
    const { fake } = await open([]);
    const t = text(fake.lastPayload());
    expect(t).toContain("Nobody yet.");
    expect(t).not.toContain("You're");
    expect(find(fake.lastPayload(), "jump")).toBeUndefined();
});

test("leaderboard: 10 members per page and a page row from 11 on", async () => {
    const { fake } = await open(members(11));
    expect(text(fake.lastPayload())).toContain("<@u10>");
    expect(text(fake.lastPayload())).not.toContain("<@u11> ·");
    expect(find(fake.lastPayload(), "jump")?.label).toBe("1 / 2");
    await fake.emit(fake.click("next", VIEWER));
    expect(text(fake.lastPayload())).toContain("`#11` <@u11> · `90`");
    expect(text(fake.lastPayload())).not.toContain("<@u1> ·");

    const small = await open(members(10));
    expect(find(small.fake.lastPayload(), "jump")).toBeUndefined();
});

test("leaderboard: the viewer's line stays on every page", async () => {
    const { fake } = await open(members(12));
    await fake.emit(fake.click("next", VIEWER));
    expect(text(fake.lastPayload())).toContain("You're #7 · `94`");
});

test("leaderboard: changing the metric loads it and goes back to page 1", async () => {
    const { fake, loads } = await open(members(11), { data: { hours: members(15, (i) => 90_000 - i) } });
    await fake.emit(fake.click("next", VIEWER));
    await fake.emit(fake.click("metric:hours", VIEWER));
    expect(loads).toEqual([["hours", "week"]]);
    expect(find(fake.lastPayload(), "jump")?.label).toBe("1 / 2");
    expect(find(fake.lastPayload(), "metric:hours")).toMatchObject({ style: ButtonStyle.Primary, disabled: true });
    expect(find(fake.lastPayload(), "metric:rares")).toMatchObject({ style: ButtonStyle.Secondary, disabled: false });
});

test("leaderboard: changing the period loads it, keeps the metric and goes back to page 1", async () => {
    const { fake, loads } = await open(members(11), { data: { rares: members(13) } });
    await fake.emit(fake.click("next", VIEWER));
    await fake.emit(fake.click("period", VIEWER, ["month"]));
    expect(loads).toEqual([["rares", "month"]]);
    const t = text(fake.lastPayload());
    expect(t).toContain("Rares · Last 30 days");
    expect(find(fake.lastPayload(), "jump")?.label).toBe("1 / 2");
    expect(find(fake.lastPayload(), "period")?.options?.map((o) => [o.value, o.default])).toEqual([
        ["week", false],
        ["month", true],
        ["all", false],
    ]);
    await fake.emit(fake.click("period", VIEWER, ["all"]));
    expect(text(fake.lastPayload())).toContain("Rares · All time");
});

test("leaderboard: the Seeds ranking is hidden with the economy off", async () => {
    const { fake, loads } = await open(members(3), { economy: false });
    expect(find(fake.lastPayload(), "metric:rares")).toBeDefined();
    expect(find(fake.lastPayload(), "metric:hours")).toBeDefined();
    expect(find(fake.lastPayload(), "metric:seeds")).toBeUndefined();
    expect(loads).toEqual([]);
    expect(text(fake.lastPayload())).toContain("Rares · Last 7 days");

    const on = await open(members(3), { economy: true });
    expect(find(on.fake.lastPayload(), "metric:seeds")).toBeDefined();
});
