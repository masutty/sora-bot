import { expect, test } from "bun:test";
import { createFakeViewTransport, type ViewPayload } from "@/define";
import type { CaseRow } from "../types";
import { casesView } from "./cases.view";

const OWNER = "owner";

const row = (n: number): CaseRow => ({
    id: `CASE${String(n).padStart(3, "0")}`,
    guild_id: "g1",
    kind: "warn",
    user_id: "u1",
    moderator_id: "m1",
    reason: `reason ${n}`,
    weight: 1,
    role_id: null,
    created_at: new Date(1_700_000_000_000 + n * 1000),
    expires_at: null,
    ended_at: null,
    end_reason: null,
    ended_by: null,
    end_note: null,
    triggered_by: null,
    threshold_level: null,
    dm_delivered: null,
    dm_error: null,
});

const text = (p: ViewPayload) => JSON.stringify((p.components ?? []).map((c) => (c as { toJSON(): unknown }).toJSON()));

async function open(total: number) {
    const all = Array.from({ length: total }, (_, i) => row(total - i)); // newest first
    const asked: number[] = [];
    const fake = createFakeViewTransport();
    void fake.run(
        casesView({
            userId: "u1",
            count: async () => total,
            list: async (limit, offset) => {
                asked.push(offset);
                return all.slice(offset, offset + limit);
            },
        }),
        undefined,
        OWNER,
    );
    await fake.flush();
    return { fake, asked };
}

test("lists newest first with the total", async () => {
    const { fake } = await open(3);
    const t = text(fake.lastPayload());
    expect(t).toContain("Cases of <@u1>**\\n-# 3 cases");
    expect(t.indexOf("CASE003")).toBeLessThan(t.indexOf("CASE001"));
});

test("an empty list says so and has no page buttons", async () => {
    const { fake } = await open(0);
    expect(text(fake.lastPayload())).toContain("No cases.");
    expect(text(fake.lastPayload())).not.toContain(":next");
});

test("paginates by the page size", async () => {
    const { fake, asked } = await open(10);
    expect(text(fake.lastPayload())).not.toContain("CASE002");
    await fake.emit(fake.click("next", OWNER));
    expect(asked).toEqual([0, 8]);
    expect(text(fake.lastPayload())).toContain("CASE002");
    expect(text(fake.lastPayload())).not.toContain("CASE010");
});
