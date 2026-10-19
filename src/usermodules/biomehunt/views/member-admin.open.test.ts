import { expect, test } from "bun:test";
import { fakeMember } from "@/core/command/fakes";
import type { CommandArgs, CommandContext } from "@/define";
import { UserFacingError } from "@/define";
import bhAdmin from "../commands/bh-admin.command";
import manageMember from "../commands/manage-member.command";
import { openMemberAdmin, resolveTargetMember } from "./member-admin.open";

function argsWith(getMember: () => Promise<unknown>): CommandArgs {
    return { getMember } as unknown as CommandArgs;
}

function fakeCtx() {
    const calls: Array<[string, unknown]> = [];
    const ctx = {
        defer: async (opts: unknown) => void calls.push(["defer", opts]),
        reply: async (payload: unknown) => void calls.push(["reply", payload]),
        open: async () => void calls.push(["open", undefined]),
    } as unknown as CommandContext;
    return { ctx, calls };
}

test("resolveTargetMember returns null when the user is not a member of the server", async () => {
    const args = argsWith(async () => {
        throw new UserFacingError("That user isn't a member of this server.");
    });
    expect(await resolveTargetMember(args)).toBeNull();
});

test("resolveTargetMember returns the member and rethrows unexpected errors", async () => {
    const member = fakeMember("1");
    expect(await resolveTargetMember(argsWith(async () => member))).toBe(member);
    await expect(
        resolveTargetMember(
            argsWith(async () => {
                throw new Error("boom");
            }),
        ),
    ).rejects.toThrow("boom");
});

test("openMemberAdmin tells the admin when the user is not in this server and opens nothing", async () => {
    const { ctx, calls } = fakeCtx();
    await openMemberAdmin(ctx, {} as never, null);
    expect(calls.map(([k]) => k)).toEqual(["defer", "reply"]);
    expect(calls[0]?.[1]).toEqual({ ephemeral: true });
    expect(JSON.stringify(calls[1]?.[1])).toContain("That user isn't in this server.");
});

test("openMemberAdmin defers publicly and opens the panel when the member is present", async () => {
    const { ctx, calls } = fakeCtx();
    await openMemberAdmin({ ...ctx, client: {} as never } as CommandContext, { id: "g1" } as never, fakeMember("1"));
    expect(calls.map(([k]) => k)).toEqual(["defer", "open"]);
    expect(calls[0]?.[1]).toBeUndefined();
});

test("Manage member is a guild-only, admin-only user context menu", () => {
    expect(manageMember.name).toBe("Manage member");
    expect(manageMember.contextMenu).toBe("user");
    expect(manageMember.guildOnly).toBe(true);
    expect(manageMember.adminOnly).toBe(bhAdmin.adminOnly);
    expect(manageMember.showOnHelp).toBe(false);
});
