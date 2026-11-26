import { expect, test } from "bun:test";
import { MessageFlags, PermissionFlagsBits } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { type CaseKind, type CaseRow, ModerationError } from "../types";
import { type UndoComponentDeps, undoComponent } from "./undo.component";

const NOW = new Date("2026-01-01T06:00:00Z");
const POSTED = Math.floor(NOW.getTime() / 1000) - 60;

type Reply = { content?: string; flags?: unknown };

async function click(
    opts: { kind?: CaseKind; age?: number; perms?: bigint; ended?: boolean; roleId?: string; roles?: string[]; failWith?: Error } = {},
) {
    const calls: Array<[string, unknown]> = [];
    const replies: Reply[] = [];
    const updates: unknown[] = [];
    const row = {
        id: "AB12",
        guild_id: "g",
        kind: opts.kind ?? "warn",
        user_id: "u",
        role_id: "r1",
        ended_at: opts.ended ? new Date() : null,
    } as CaseRow;
    const record = (name: string) => async (input: unknown) => {
        calls.push([name, input]);
        return [];
    };
    const deps: UndoComponentDeps = {
        now: () => NOW,
        getCase: async () => row,
        getSettings: async () => ({ moderator_role_id: opts.roleId ?? null }),
        service: () =>
            ({ unwarn: record("unwarn"), unmute: record("unmute"), unban: record("unban"), untemprole: record("untemprole") }) as never,
    };
    const submit = {
        fields: { getTextInputValue: () => " because " },
        deferUpdate: async () => void calls.push(["deferUpdate", null]),
        deferReply: async () => void calls.push(["deferReply", null]),
        followUp: async (p: Reply) => void replies.push(p),
        editReply: async (p: unknown) => void updates.push(p),
        isFromMessage: () => true,
    };
    if (opts.failWith) {
        const error = opts.failWith;
        deps.service = () => ({ unwarn: async () => Promise.reject(error) }) as never;
    }
    const perms = opts.perms ?? PermissionFlagsBits.ModerateMembers | PermissionFlagsBits.BanMembers;
    const interaction = {
        id: "i1",
        guildId: "g",
        user: { id: "mod" },
        isButton: () => true,
        member: { roles: opts.roles ?? [] },
        memberPermissions: { has: (p: bigint) => (perms & p) === p },
        message: {
            components: [
                { type: 17, toJSON: () => ({ type: 17 }) },
                { type: 1, toJSON: () => ({ type: 1 }) },
            ],
        },
        reply: async (p: Reply) => void replies.push(p),
        showModal: async (m: unknown) => void calls.push(["modal", m]),
        awaitModalSubmit: async () => submit,
    };
    const parts = ["AB12", String(POSTED - (opts.age ?? 0))];
    await undoComponent(deps).handle(interaction as never, parts, {} as BotClient);
    return { calls, replies, updates };
}

test("after 12 hours the click only says it expired", async () => {
    const { calls, replies } = await click({ age: 12 * 3600 + 120 });
    expect(replies[0]?.content).toBe("This button expired, so use `case AB12` instead.");
    expect(replies[0]?.flags).toBe(MessageFlags.Ephemeral);
    expect(calls).toEqual([]);
});

test("a clicker without the permission is refused", async () => {
    const { calls, replies } = await click({ kind: "ban", perms: PermissionFlagsBits.ModerateMembers });
    expect(replies[0]?.content).toContain("permission");
    expect(calls).toEqual([]);
});

test("with a moderator role, the role holder or an Administrator may undo; native permission alone may not", async () => {
    const role = { roleId: "r9", perms: 0n };
    expect((await click({ ...role, roles: ["r9"] })).calls[0]?.[0]).toBe("modal");
    expect((await click({ roleId: "r9", perms: PermissionFlagsBits.Administrator })).calls[0]?.[0]).toBe("modal");
    const refused = await click({ roleId: "r9", perms: PermissionFlagsBits.ModerateMembers | PermissionFlagsBits.BanMembers });
    expect(refused.replies[0]?.content).toContain("permission");
    expect(refused.calls).toEqual([]);
});

test("an ended case gets a notice, no modal", async () => {
    const { calls, replies } = await click({ ended: true });
    expect(replies[0]?.content).toBe("Case `AB12` already ended.");
    expect(calls).toEqual([]);
});

test("the happy path acknowledges the submit first, calls the service with the reason and removes the button", async () => {
    const { calls, updates } = await click({ kind: "mute" });
    expect(calls[0]?.[0]).toBe("modal");
    expect(calls[1]?.[0]).toBe("deferUpdate");
    expect(calls[2]).toEqual(["unmute", { guildId: "g", by: "mod", reason: "because", userId: "u" }]);
    expect(updates).toEqual([{ components: [{ type: 17 }] }]);
});

test("a refused revoke after the submit is told as an ephemeral follow-up", async () => {
    const { replies, updates } = await click({ failWith: new ModerationError("Warn `AB12` already ended.") });
    expect(replies).toEqual([{ content: "Warn `AB12` already ended.", flags: MessageFlags.Ephemeral }]);
    expect(updates).toEqual([]);
});

test("each kind calls its own method", async () => {
    expect((await click({ kind: "warn" })).calls[2]?.[0]).toBe("unwarn");
    expect((await click({ kind: "ban" })).calls[2]?.[0]).toBe("unban");
    expect((await click({ kind: "temprole" })).calls[2]).toEqual([
        "untemprole",
        { guildId: "g", by: "mod", reason: "because", userId: "u", roleId: "r1" },
    ]);
});
