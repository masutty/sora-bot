import { expect, test } from "bun:test";
import { PermissionFlagsBits as P } from "discord.js";
import { assertCanModerate, canManageSettings, canModerate, type ModAction } from "./permission";

const member = (perms: bigint, roles: string[] = []) => ({ permissions: { has: (p: bigint) => (perms & p) === p }, roles });
const withRole = { moderator_role_id: "r1" };
const noRole = { moderator_role_id: null };
const actions: ModAction[] = ["moderate", "kick", "ban"];

test("role set: the role holder is allowed without any native permission", () => {
    for (const a of actions) expect(canModerate(member(0n, ["r1"]), a, withRole)).toBe(true);
});

test("role set: an Administrator is allowed without the role", () => {
    for (const a of actions) expect(canModerate(member(P.Administrator), a, withRole)).toBe(true);
});

test("role set: native permissions alone are refused", () => {
    for (const a of actions)
        expect(canModerate(member(P.ModerateMembers | P.KickMembers | P.BanMembers, ["other"]), a, withRole)).toBe(false);
});

test("role set: works with a role manager as well as a role id list", () => {
    const manager = { permissions: { has: () => false }, roles: { cache: new Set(["r1"]) } };
    expect(canModerate(manager, "moderate", withRole)).toBe(true);
});

test("role unset: the native permission of each action decides", () => {
    expect(canModerate(member(P.ModerateMembers), "moderate", noRole)).toBe(true);
    expect(canModerate(member(P.ModerateMembers), "ban", noRole)).toBe(false);
    expect(canModerate(member(P.KickMembers), "kick", noRole)).toBe(true);
    expect(canModerate(member(P.BanMembers), "ban", noRole)).toBe(true);
    expect(canModerate(member(0n, ["r1"]), "moderate", noRole)).toBe(false);
});

test("assertCanModerate refuses with a message the user can read", () => {
    expect(() => assertCanModerate(member(0n), "ban", noRole)).toThrow("permission");
    expect(() => assertCanModerate(member(0n), "ban", withRole)).toThrow("<@&r1>");
    expect(() => assertCanModerate(member(0n, ["r1"]), "ban", withRole)).not.toThrow();
});

test("settings need Manage Server or Administrator, never the moderator role", () => {
    expect(canManageSettings(member(P.ManageGuild))).toBe(true);
    expect(canManageSettings(member(0n, ["r1"]))).toBe(false);
});
