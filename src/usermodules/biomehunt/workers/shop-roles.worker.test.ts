import { describe, expect, test } from "bun:test";
import type { GuildMember } from "discord.js";
import { createShopRolesTick, regrantOnJoin, type ShopRolesDeps } from "./shop-roles.worker";

const NOW = new Date("2026-10-23T12:00:00Z");
const due = (n: number) => ({ userId: n, guildId: "g1", discordUserId: `d${n}`, roleId: `r${n}` });

function makeDeps(over: Partial<ShopRolesDeps> = {}) {
    const deleted: Array<[number, string]> = [];
    const added: string[] = [];
    const deps: ShopRolesDeps = {
        now: () => NOW,
        getDueGrants: async () => [due(1)],
        getActiveGrantEnd: async () => null,
        removeRole: async () => "ok",
        deleteGrant: async (userId, roleId) => {
            deleted.push([userId, roleId]);
            return true;
        },
        addRole: async (_g, _u, roleId) => {
            added.push(roleId);
        },
        ...over,
    };
    return { deps, deleted, added };
}

describe("createShopRolesTick", () => {
    test("deletes the grant when the role is removed", async () => {
        const { deps, deleted } = makeDeps();
        await createShopRolesTick(deps)();
        expect(deleted).toEqual([[1, "r1"]]);
    });

    test("deletes the grant when the member or role is gone", async () => {
        const { deps, deleted } = makeDeps({ removeRole: async () => "gone" });
        await createShopRolesTick(deps)();
        expect(deleted).toEqual([[1, "r1"]]);
    });

    test("keeps the grant when the removal fails", async () => {
        const { deps, deleted } = makeDeps({ removeRole: async () => "failed" });
        await createShopRolesTick(deps)();
        expect(deleted).toEqual([]);
    });

    test("asks for at most 50 due grants", async () => {
        let limit = 0;
        const { deps } = makeDeps({
            getDueGrants: async (_now, l) => {
                limit = l;
                return [];
            },
        });
        await createShopRolesTick(deps)();
        expect(limit).toBe(50);
    });

    test("skips a grant renewed since it was read", async () => {
        const removed: string[] = [];
        const { deps, deleted } = makeDeps({
            getActiveGrantEnd: async () => new Date("2026-10-24T00:00:00Z"),
            removeRole: async (_g, _u, roleId) => {
                removed.push(roleId);
                return "ok";
            },
        });
        await createShopRolesTick(deps)();
        expect(removed).toEqual([]);
        expect(deleted).toEqual([]);
    });

    test("gives the role back when a renewal lands during the removal", async () => {
        const { deps, added } = makeDeps({ deleteGrant: async () => false });
        await createShopRolesTick(deps)();
        expect(added).toEqual(["r1"]);
    });

    test("a failing add-back does not stop the tick", async () => {
        const { deps } = makeDeps({
            getDueGrants: async () => [due(1), due(2)],
            deleteGrant: async () => false,
            addRole: async () => {
                throw new Error("boom");
            },
        });
        await createShopRolesTick(deps)();
    });

    test("a throwing removal on one grant does not stop the others", async () => {
        const { deps, deleted } = makeDeps({
            getDueGrants: async () => [due(1), due(2)],
            removeRole: async (_g, _u, roleId) => {
                if (roleId === "r1") throw new Error("boom");
                return "ok";
            },
        });
        await createShopRolesTick(deps)();
        expect(deleted).toEqual([[2, "r2"]]);
    });
});

describe("regrantOnJoin", () => {
    const member = { guild: { id: "g1" }, id: "d1" } as unknown as GuildMember;
    const grants = [
        { roleId: "r1", endsAt: new Date("2026-10-24T00:00:00Z") },
        { roleId: "r2", endsAt: new Date("2026-10-25T00:00:00Z") },
    ];

    test("adds the role of every active grant", async () => {
        const added: string[] = [];
        await regrantOnJoin(member, {
            now: () => NOW,
            getMemberActiveGrants: async () => grants,
            addRole: async (_g, _u, roleId) => {
                added.push(roleId);
            },
        });
        expect(added).toEqual(["r1", "r2"]);
    });

    test("swallows a failing add and still tries the next role", async () => {
        const added: string[] = [];
        await regrantOnJoin(member, {
            now: () => NOW,
            getMemberActiveGrants: async () => grants,
            addRole: async (_g, _u, roleId) => {
                if (roleId === "r1") throw new Error("boom");
                added.push(roleId);
            },
        });
        expect(added).toEqual(["r2"]);
    });
});
