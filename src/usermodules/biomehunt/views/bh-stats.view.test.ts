import { expect, test } from "bun:test";
import { ContainerBuilder } from "discord.js";
import { createFakeViewTransport, type ViewPayload } from "@/define";
import type { ActivityStatus, UserRow } from "../types";
import { type UsersStatsInput, usersStatsView } from "./bh-stats.view";

const OWNER = "owner";

function fakeUser(id: number): UserRow {
    return {
        id,
        guild_id: "g1",
        discord_user_id: String(id),
        current_status: "active",
        last_activity_at: null,
        paused_at: null,
        created_at: new Date(),
        seeds: 0,
        xp: 0,
        flower: null,
    };
}

function fakeInput(): UsersStatsInput {
    const active: UserRow[] = Array.from({ length: 15 }, (_, i) => fakeUser(i + 1));
    const usersByStatus: Record<ActivityStatus, UserRow[]> = { active, idle: [], inactive: [] };
    return { overview: new ContainerBuilder(), usersByStatus };
}

function text(payload: ViewPayload): string {
    const out: string[] = [];
    const walk = (node: unknown) => {
        if (node === null || typeof node !== "object") return;
        const json = typeof (node as { toJSON?: unknown }).toJSON === "function" ? (node as { toJSON(): unknown }).toJSON() : node;
        if (Array.isArray(json)) {
            for (const child of json) walk(child);
            return;
        }
        const obj = json as { content?: string; components?: unknown };
        if (obj.content) out.push(obj.content);
        walk(obj.components);
    };
    walk(payload.components);
    return out.join("\n");
}

test("biomehunt.stats-users: a stale prev/next click after switching to Overview is a no-op, not a throw", async () => {
    const fake = createFakeViewTransport();
    void fake.run(usersStatsView, fakeInput(), OWNER);
    await fake.flush();

    await fake.emit(fake.click("tab:active", OWNER));
    // Grab the "next" customId BEFORE switching away - simulates a click that lands after the
    // message already moved on (a stale/racing interaction), not a click on the current render.
    const staleNext = fake.id("next");

    await fake.emit(fake.click("tab:overview", OWNER));

    // Same session, same message: re-dispatch the stale customId. Must not throw (the engine
    // catching it and showing a generic "something went wrong" quip is still a regression - it
    // should be a silent no-op, so assert nothing was notified at all).
    await fake.emit(fake.clickId(staleNext, OWNER));

    expect(fake.closed).toBe(0);
    expect(fake.notifies).toHaveLength(0);
    // Still showing the Overview tab's content, untouched by the stale click.
    expect(text(fake.lastPayload())).not.toContain("Page");
});

test("biomehunt.stats-users: disableActive is off - reclicking the active status tab still resets to page 1", async () => {
    const fake = createFakeViewTransport();
    void fake.run(usersStatsView, fakeInput(), OWNER);
    await fake.flush();

    await fake.emit(fake.click("tab:active", OWNER));
    await fake.emit(fake.click("next", OWNER));
    expect(text(fake.lastPayload())).toContain("Page 2");

    // Reclicking the already-active "active" tab is possible (not disabled) and resets the page.
    await fake.emit(fake.click("tab:active", OWNER));
    expect(text(fake.lastPayload())).toContain("Page 1");
});
