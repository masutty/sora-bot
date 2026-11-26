import { expect, test } from "bun:test";
import { createFakeViewTransport, type ViewPayload } from "@/define";
import { type CaseRow, ModerationError } from "../types";
import { caseView } from "./case.view";

const OWNER = "owner";

const warn = (extra: Partial<CaseRow> = {}): CaseRow => ({
    id: "K7XQ2MP",
    guild_id: "g1",
    kind: "warn",
    user_id: "u1",
    moderator_id: "m1",
    reason: "spam",
    weight: 1,
    role_id: null,
    created_at: new Date(1_700_000_000_000),
    expires_at: null,
    ended_at: null,
    end_reason: null,
    ended_by: null,
    end_note: null,
    triggered_by: null,
    threshold_level: null,
    dm_delivered: null,
    dm_error: null,
    ...extra,
});

const json = (p: ViewPayload) => JSON.stringify((p.components ?? []).map((c) => (c as { toJSON(): unknown }).toJSON()));

async function open(
    row: CaseRow,
    unwarn = async (_input: Record<string, unknown>) => ({ case: row, undone: [] as CaseRow[] }),
    canRevoke?: () => Promise<boolean>,
) {
    const calls: Record<string, unknown>[] = [];
    let current = row;
    const fake = createFakeViewTransport();
    void fake.run(
        caseView({
            guildId: "g1",
            row,
            canRevoke,
            service: {
                unwarn: async (input) => {
                    calls.push(input);
                    const out = await unwarn(input);
                    current = warn({ ended_at: new Date(), end_reason: "revoked" });
                    return out;
                },
            },
            reload: async () => ({ row: current, events: [] }),
        }),
        undefined,
        OWNER,
    );
    await fake.flush();
    return { fake, calls };
}

async function submit(fake: Awaited<ReturnType<typeof open>>["fake"], reason: string) {
    const ack = fake.modalSubmit(OWNER);
    fake.modalResult = async () => ({ values: { reason }, ack });
    await fake.emit(fake.click("unwarn", OWNER));
}

test("the Revoke button shows only on an active warn", async () => {
    expect(json((await open(warn())).fake.lastPayload())).toContain(":unwarn");
    expect(json((await open(warn({ ended_at: new Date(), end_reason: "revoked" }))).fake.lastPayload())).not.toContain(":unwarn");
    expect(json((await open(warn({ kind: "mute" }))).fake.lastPayload())).not.toContain(":unwarn");
});

test("the modal calls unwarn with the reason and the case redraws as revoked", async () => {
    const { fake, calls } = await open(warn());
    await submit(fake, "  mistake ");
    expect(fake.modals.at(-1)?.spec.title).toBe("Revoke K7XQ2MP");
    expect(calls).toEqual([{ guildId: "g1", caseId: "K7XQ2MP", by: OWNER, reason: "mistake" }]);
    expect(json(fake.lastPayload())).toContain("Revoked");
    expect(json(fake.lastPayload())).not.toContain(":unwarn");
});

test("a ModerationError is notified and the case stays", async () => {
    const { fake } = await open(warn(), async () => {
        throw new ModerationError("Nope.");
    });
    await submit(fake, "");
    expect(fake.notifies.at(-1)?.content).toBe("Nope.");
    expect(json(fake.lastPayload())).toContain(":unwarn");
});

test("Revoke is refused when the viewer no longer has the right", async () => {
    const { fake, calls } = await open(warn(), undefined, async () => false);
    await submit(fake, "x");
    expect(fake.notifies.at(-1)?.content).toContain("permission");
    expect(calls).toEqual([]);
});
