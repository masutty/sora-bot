import { expect, test } from "bun:test";
import { createFakeViewTransport, defineView, type ViewPayload } from "@/define";
import type { ReviewQueueRow } from "../repository/votes.repository";
import { VoteStatus } from "../types";
import { REVIEW_QUEUE_PER_PAGE, type ReviewQueueDeps, reviewQueueView } from "./review-queue.view";

const ADMIN = "admin-1";
const GUILD_ID = "g1";

type Json = { content?: string; label?: string; custom_id?: string; components?: unknown; accessory?: unknown };

function flatten(payload: ViewPayload): Json[] {
    const out: Json[] = [];
    const walk = (node: unknown) => {
        if (node === null || typeof node !== "object") return;
        const json = typeof (node as { toJSON?: unknown }).toJSON === "function" ? (node as { toJSON(): unknown }).toJSON() : node;
        if (Array.isArray(json)) return json.forEach(walk);
        const obj = json as Json;
        out.push(obj);
        walk(obj.components);
        walk(obj.accessory);
    };
    walk(payload.components);
    return out;
}

const text = (p: ViewPayload) => [p.content ?? "", ...flatten(p).map((c) => c.content ?? "")].filter(Boolean).join("\n");
const labels = (p: ViewPayload) => flatten(p).flatMap((c) => (c.label ? [c.label] : []));
const checks = (p: ViewPayload) => labels(p).filter((l) => l === "Check").length;

const row = (n: number, overrides: Partial<ReviewQueueRow> = {}): ReviewQueueRow => ({
    id: `vote-${n}`,
    biome: "GLITCHED",
    finderDiscordId: `finder-${n}`,
    createdAt: new Date(1_700_000_000_000 - n * 1000),
    status: VoteStatus.TIE,
    real: 1,
    fake: 1,
    finderHadFake: false,
    ...overrides,
});

/** A `ReviewQueueDeps` over an in-memory queue; the review it opens drops its vote when "Done" is clicked. */
function fakeDeps(world: { items: ReviewQueueRow[] }) {
    const opened: unknown[] = [];
    const deps: ReviewQueueDeps = {
        load: async () => [...world.items],
        reviewView: () =>
            defineView<{ id: string }, void, { id: string; guildId: string; viewerId: string }>({
                name: "test.review",
                initial: (input) => {
                    opened.push(input);
                    return { id: input.id };
                },
                render: (s, kit) => ({ content: `review ${s.id}`, components: [kit.row(kit.button("done", (b) => b.setLabel("Done")))] }),
                on: {
                    done: (c) => {
                        world.items = world.items.filter((i) => i.id !== c.state.id);
                        c.done();
                    },
                },
            }) as never,
    };
    return { deps, opened };
}

async function open(items: ReviewQueueRow[]) {
    const world = { items };
    const { deps, opened } = fakeDeps(world);
    const fake = createFakeViewTransport();
    void fake.run(reviewQueueView(deps), { guildId: GUILD_ID, viewerId: ADMIN }, ADMIN);
    await fake.flush();
    return { fake, opened };
}

test("queue: lists each item with its reasons", async () => {
    const { fake } = await open([
        row(1),
        row(2, { status: VoteStatus.NO_VOTES, real: 0, fake: 0 }),
        row(3, { status: VoteStatus.COMMUNITY_FAKE, real: 2, fake: 3 }),
        row(4, { status: VoteStatus.COMMUNITY_REAL, real: 5, fake: 1, finderHadFake: true }),
        row(5, { status: VoteStatus.COMMUNITY_REAL, real: 3, fake: 2, finderHadFake: true, finderDiscordId: null }),
    ]);
    const t = text(fake.lastPayload());
    expect(t).toContain("**Review queue**");
    expect(t).toMatch(/\*\*Glitched\*\* · <@finder-1> · <t:\d+:R>\nTie/);
    expect(t).toMatch(/<@finder-2> · <t:\d+:R>\nNo votes/);
    expect(t).toMatch(/<@finder-3> · <t:\d+:R>\nWon by 1 vote \(3–2\)\n/);
    expect(t).toMatch(/<@finder-4> · <t:\d+:R>\nFinder had a fake\n/);
    expect(t).toMatch(/\*unknown\* · <t:\d+:R>\nWon by 1 vote \(3–2\) · Finder had a fake/);
    expect(checks(fake.lastPayload())).toBe(5);
    expect(labels(fake.lastPayload())).not.toContain("1 / 1");
});

test("queue: empty says so", async () => {
    const { fake } = await open([]);
    expect(text(fake.lastPayload())).toBe("Nothing to review.");
    expect(labels(fake.lastPayload())).toEqual([]);
});

test("queue: Check opens that vote's review, and the queue reloads when it returns", async () => {
    const { fake, opened } = await open([row(1), row(2)]);
    await fake.emit(fake.click("check:1", ADMIN));
    expect(opened).toEqual([{ id: "vote-2", guildId: GUILD_ID, viewerId: ADMIN }]);
    expect(text(fake.lastPayload())).toBe("review vote-2");

    await fake.emit(fake.click("done", ADMIN));
    const t = text(fake.lastPayload());
    expect(t).toContain("<@finder-1>");
    expect(t).not.toContain("<@finder-2>");
});

test("queue: six items paginate five per page, and Check on page 2 opens the right vote", async () => {
    const { fake, opened } = await open([1, 2, 3, 4, 5, 6].map((n) => row(n)));
    expect(labels(fake.lastPayload())).toContain("1 / 2");
    expect(checks(fake.lastPayload())).toBe(REVIEW_QUEUE_PER_PAGE);
    expect(text(fake.lastPayload())).not.toContain("<@finder-6>");
    await fake.emit(fake.click("next", ADMIN));
    expect(checks(fake.lastPayload())).toBe(1);
    await fake.emit(fake.click("check:0", ADMIN));
    expect(opened).toEqual([{ id: "vote-6", guildId: GUILD_ID, viewerId: ADMIN }]);
    await fake.emit(fake.click("done", ADMIN));
    expect(text(fake.lastPayload())).toContain("<@finder-5>");
    expect(labels(fake.lastPayload())).not.toContain("2 / 2");
});
