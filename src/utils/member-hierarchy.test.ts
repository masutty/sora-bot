import { describe, expect, test } from "bun:test";
import { hierarchyRefusal, type RankedMember, roleProblem } from "./member-hierarchy";

const at = (id: string, position: number): RankedMember => ({ id, roles: { highest: { position } } });
const me = at("bot", 10);
const base = { ownerId: "owner", me };

test("allows a moderator and the bot above the target", () => {
    expect(hierarchyRefusal({ ...base, actor: at("mod", 5), targetId: "t", target: at("t", 2) })).toBeNull();
});

test("refuses self, the bot and the owner, even without a member", () => {
    const actor = at("mod", 5);
    expect(hierarchyRefusal({ ...base, actor, targetId: "mod", target: actor })).toMatch(/yourself/);
    expect(hierarchyRefusal({ ...base, actor, targetId: "bot", target: me })).toMatch(/myself/);
    expect(hierarchyRefusal({ ...base, actor, targetId: "owner", target: null })).toMatch(/owner/);
});

test("refuses an equal or higher role for the moderator, then for the bot", () => {
    expect(hierarchyRefusal({ ...base, actor: at("mod", 5), targetId: "t", target: at("t", 5) })).toMatch(/Your/);
    expect(hierarchyRefusal({ ...base, actor: at("mod", 20), targetId: "t", target: at("t", 12) })).toMatch(/My/);
});

test("a target outside the server only meets the id checks", () => {
    expect(hierarchyRefusal({ ...base, actor: at("mod", 1), targetId: "gone", target: null })).toBeNull();
});

test("the bot as actor (Auto-Punishment) is checked on its own rank only", () => {
    expect(hierarchyRefusal({ ...base, actor: null, targetId: "t", target: at("t", 2) })).toBeNull();
    expect(hierarchyRefusal({ ...base, actor: null, targetId: "t", target: at("t", 10) })).toMatch(/My/);
    expect(hierarchyRefusal({ ...base, actor: null, targetId: "bot", target: me })).toMatch(/yourself|myself/);
});

test("the owner may act on anyone below the bot", () => {
    expect(hierarchyRefusal({ ...base, actor: at("owner", 0), targetId: "t", target: at("t", 9) })).toBeNull();
});

describe("roleProblem", () => {
    const above = "⚠️ The bot can't give <@&r1> - move the bot's role above it.";
    test("missing role", () => expect(roleProblem(null, "g1", 10, true)).toBe("⚠️ That role no longer exists."));
    test("managed role", () => expect(roleProblem({ managed: true, id: "r1", position: 1 }, "g1", 10, true)).toBe(above));
    test("everyone role", () =>
        expect(roleProblem({ managed: false, id: "g1", position: 0 }, "g1", 10, true)).toBe(above.replace("r1", "g1")));
    test("role above the bot", () => expect(roleProblem({ managed: false, id: "r1", position: 10 }, "g1", 10, true)).toBe(above));
    test("no Manage Roles", () =>
        expect(roleProblem({ managed: false, id: "r1", position: 1 }, "g1", 10, false)).toBe(
            "⚠️ The bot needs Manage Roles to give <@&r1>.",
        ));
    test("giveable", () => expect(roleProblem({ managed: false, id: "r1", position: 1 }, "g1", 10, true)).toBeNull());
});
