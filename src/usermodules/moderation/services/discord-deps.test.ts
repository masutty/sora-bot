import { expect, test } from "bun:test";
import type { Client } from "discord.js";
import { createDiscordDeps } from "./discord-deps";

const at = (id: string, position: number, extra: Record<string, unknown> = {}) => ({
    id,
    roles: { highest: { position }, cache: new Map<string, unknown>() },
    permissions: { has: () => true },
    ...extra,
});

const role = (id: string, position: number, managed = false) => ({ id, position, managed });

function setup(members: Record<string, ReturnType<typeof at>>, roles: Record<string, ReturnType<typeof role>> = {}) {
    const guild = {
        ownerId: "owner",
        name: "Sora",
        roles: { cache: new Map(Object.entries(roles)), fetch: async () => null },
        members: {
            me: members.bot,
            fetch: async (id: string) => {
                const member = members[id];
                if (!member) throw new Error("Unknown Member");
                return member;
            },
        },
    };
    return createDiscordDeps({ guilds: { cache: new Map([["g", guild]]) }, user: { id: "bot" } } as unknown as Client);
}

test("canAct allows a moderator above the target and refuses one below", async () => {
    const deps = setup({ bot: at("bot", 10), mod: at("mod", 5), low: at("low", 1), high: at("high", 7) });
    expect(await deps.canAct("g", "mod", "low")).toBeNull();
    expect(await deps.canAct("g", "mod", "high")).toMatch(/Your highest role/);
});

test("canAct refuses the owner and lets a user outside the server through", async () => {
    const deps = setup({ bot: at("bot", 10), mod: at("mod", 5) });
    expect(await deps.canAct("g", "mod", "owner")).toMatch(/owner/);
    expect(await deps.canAct("g", "mod", "gone")).toBeNull();
});

test("canAct with no moderator checks the bot's own rank", async () => {
    const deps = setup({ bot: at("bot", 10), peer: at("peer", 10), low: at("low", 1) });
    expect(await deps.canAct("g", null, "low")).toBeNull();
    expect(await deps.canAct("g", null, "peer")).toMatch(/My highest role/);
});

test("guildName falls back when the guild is unknown", () => {
    const deps = setup({ bot: at("bot", 10) });
    expect(deps.guildName("g")).toBe("Sora");
    expect(deps.guildName("x")).toBe("the server");
});

test("canAct with an action also needs the bot to be able to do it", async () => {
    const deps = setup({
        bot: at("bot", 10),
        mod: at("mod", 5),
        ok: at("ok", 1, { moderatable: true, kickable: true, bannable: true }),
        no: at("no", 1, { moderatable: false, kickable: false, bannable: false }),
    });
    for (const action of ["mute", "kick", "ban"] as const) {
        expect(await deps.canAct("g", "mod", "ok", action)).toBeNull();
        expect(await deps.canAct("g", "mod", "no", action)).toMatch(/I can't do that/);
    }
});

test("canGiveRole refuses managed, @everyone, too high and held roles; the owner may pass the actor's rank", async () => {
    const deps = setup(
        {
            bot: at("bot", 10),
            mod: at("mod", 5),
            owner: at("owner", 5),
            t: at("t", 1, { roles: { highest: { position: 1 }, cache: new Map([["held", true]]) } }),
        },
        {
            low: role("low", 3),
            high: role("high", 7),
            bots: role("bots", 2, true),
            g: role("g", 0),
            held: role("held", 2),
            top: role("top", 10),
        },
    );
    expect(await deps.canGiveRole("g", "mod", "t", "low")).toBeNull();
    expect(await deps.canGiveRole("g", "mod", "t", "high")).toMatch(/Your highest role/);
    expect(await deps.canGiveRole("g", "owner", "t", "high")).toBeNull();
    expect(await deps.canGiveRole("g", "owner", "t", "top")).toMatch(/bot can't give/);
    expect(await deps.canGiveRole("g", "mod", "t", "bots")).toMatch(/bot can't give/);
    expect(await deps.canGiveRole("g", "mod", "t", "g")).toMatch(/bot can't give/);
    expect(await deps.canGiveRole("g", "mod", "t", "held")).toMatch(/already has/);
    expect(await deps.canGiveRole("g", "mod", "t", "gone")).toMatch(/no longer exists/);
});
