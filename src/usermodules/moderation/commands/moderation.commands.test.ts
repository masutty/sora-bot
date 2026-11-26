import { describe, expect, test } from "bun:test";
import type { GuildCommandContext } from "@/define";
import { fakeClient, fakeGuild, fakeMember, fakeUser } from "../../../core/command/fakes";
import { deriveSchema, deriveSubcommandSchema, PrefixArgs } from "../../../core/command/prefix-args";
import { handlers, type ModCommandDeps, moderationCommands } from "./moderation.commands";

const GUILD = "guild1";
const TARGET = "111111111111111111";
const ROLE = "333333333333333333";

const byName = (name: string) => {
    const command = moderationCommands.find((c) => c.name === name);
    if (!command) throw new Error(`no ${name}`);
    return command;
};

/** A prefix invocation parsed by the real PrefixArgs with the command's own schema. */
function prefix(name: string, tokens: string[]) {
    const command = byName(name);
    const schema = deriveSchema(command.options as never, new Set(command.prefixNamedOnly));
    const client = fakeClient({ [TARGET]: fakeUser(TARGET) });
    const guild = fakeGuild({ members: { [TARGET]: fakeMember(TARGET) }, roles: { [ROLE]: { id: ROLE } as never } });
    const subs = deriveSubcommandSchema(command.options as never, new Set(command.prefixNamedOnly));
    const args = new PrefixArgs(tokens, schema, guild, client, subs);
    const replies: unknown[] = [];
    const calls: Record<string, unknown>[] = [];
    const row = { id: "K7XQ2MP", reason: "r", dm_delivered: false };
    const service = new Proxy(
        {},
        {
            get: (_t, method: string) => async (input: Record<string, unknown>) => {
                calls.push({ method, ...input });
                return method === "warn"
                    ? { case: row, auto: null, autoSkipped: null }
                    : method === "unban" || method === "untemprole"
                      ? [row]
                      : row;
            },
        },
    );
    const ctx = {
        mode: "prefix",
        client,
        guild: { id: GUILD },
        user: { id: "mod" },
        args: {
            getUser: (n: string) => args.getUser(n),
            getRole: (n: string) => args.getRole(n),
            getString: (n: string, required?: boolean) => {
                const value = args.getString(n);
                if (value === null && required) throw new Error(`missing ${n}`);
                return value;
            },
            isNamed: (n: string) => args.isNamed(n),
            getInteger: (n: string) => args.getInteger(n),
            getSubcommand: () => args.getSubcommand(),
        },
        raw: { kind: "prefix", args },
        defer: async () => {},
        reply: async (p: unknown) => void replies.push(p),
    } as unknown as GuildCommandContext;
    const deps = { service } as unknown as ModCommandDeps;
    return { run: () => handlers[name as "warn"](ctx, deps), calls, replies };
}

describe("definitions", () => {
    test("expose exactly the user-facing names", () => {
        expect(moderationCommands.map((c) => c.name)).toEqual([
            "warn",
            "unwarn",
            "warns",
            "mute",
            "unmute",
            "temprole",
            "kick",
            "ban",
            "softban",
            "unban",
            "cases",
            "modlogs",
            "case",
            "reason",
            "mclear",
            "moderator",
        ]);
    });

    test("moderator has the settings and stats subcommands, modstats is gone", () => {
        const json = byName("moderator").options?.toJSON() as { options: { name: string }[] };
        expect(json.options.map((o) => o.name)).toEqual(["settings", "stats"]);
        expect(moderationCommands.some((c) => c.name === "modstats")).toBe(false);
    });

    test("no moderation command is hidden by a native default permission, and mclear is prefix-only", () => {
        for (const c of moderationCommands) {
            expect(c.permissions).toBeUndefined();
            expect(c.options?.toJSON().default_member_permissions ?? null).toBeNull();
        }
        expect(byName("mclear").modes).toBe("prefix");
    });

    test("modlogs is cases with another name: same options and handler", () => {
        expect(byName("modlogs").options?.toJSON().options).toEqual(byName("cases").options?.toJSON().options);
        expect(byName("modlogs").description).toBe(byName("cases").description);
    });
});

describe("prefix parsing", () => {
    test("ban with plain words is permanent and keeps the whole reason", async () => {
        const t = prefix("ban", [`<@${TARGET}>`, "stop", "doing", "that"]);
        await t.run();
        expect(t.calls[0]).toMatchObject({ method: "ban", durationS: null, reason: "stop doing that", userId: TARGET });
    });

    test("a bare number after the user is part of the reason, not a duration", async () => {
        const t = prefix("ban", [`<@${TARGET}>`, "5", "spam"]);
        await t.run();
        expect(t.calls[0]).toMatchObject({ durationS: null, reason: "5 spam" });
    });

    test("ban with a duration", async () => {
        const t = prefix("ban", [`<@${TARGET}>`, "7d", "raid"]);
        await t.run();
        expect(t.calls[0]).toMatchObject({ durationS: 604800, reason: "raid" });
    });

    test("warn 2x sets the weight", async () => {
        const t = prefix("warn", [`<@${TARGET}>`, "2x", "spam"]);
        await t.run();
        expect(t.calls[0]).toMatchObject({ method: "warn", weight: 2, reason: "spam" });
    });

    test("warn without a weight is 1", async () => {
        const t = prefix("warn", [`<@${TARGET}>`, "x3", "spam"]);
        await t.run();
        expect(t.calls[0]).toMatchObject({ weight: 1, reason: "x3 spam" });
    });

    test("mute needs a duration with a unit", async () => {
        await expect(prefix("mute", [`<@${TARGET}>`, "30", "x"]).run()).rejects.toThrow(/unit/);
        const t = prefix("mute", [`<@${TARGET}>`, "30m", "calm", "down"]);
        await t.run();
        expect(t.calls[0]).toMatchObject({ method: "mute", durationS: 1800, reason: "calm down" });
    });

    test("a named reason is kept whole: no weight or duration is read from it", async () => {
        const w = prefix("warn", [`<@${TARGET}>`, "reason:2x"]);
        await w.run();
        expect(w.calls[0]).toMatchObject({ weight: 1, reason: "2x" });
        const b = prefix("ban", [`<@${TARGET}>`, "reason:7d"]);
        await b.run();
        expect(b.calls[0]).toMatchObject({ durationS: null, reason: "7d" });
    });

    test("unban takes the ID as text and refuses garbage", async () => {
        const t = prefix("unban", ["222222222222222222"]);
        await t.run();
        expect(t.calls[0]).toMatchObject({ method: "unban", userId: "222222222222222222" });
        await expect(prefix("unban", ["nope"]).run()).rejects.toThrow(/not a Discord id/);
    });

    test("temprole add gives the role for the duration", async () => {
        const t = prefix("temprole", ["add", `<@${TARGET}>`, "1h", `<@&${ROLE}>`]);
        await t.run();
        expect(t.calls[0]).toMatchObject({ method: "temprole", userId: TARGET, roleId: ROLE, durationS: 3600 });
    });

    test("temprole remove revokes early and confirms with the reason", async () => {
        const t = prefix("temprole", ["remove", `<@${TARGET}>`, `<@&${ROLE}>`, "my", "mistake"]);
        await t.run();
        expect(t.calls[0]).toMatchObject({ method: "untemprole", userId: TARGET, roleId: ROLE, by: "mod", reason: "my mistake" });
        const json = JSON.stringify((t.replies[0] as { components: { toJSON(): unknown }[] }).components.map((c) => c.toJSON()));
        expect(json).toContain(`✅ **Removed** <@&${ROLE}> from <@${TARGET}> (\`K7XQ2MP\`)`);
        expect(json).toContain("> **Reason:** my mistake");
    });

    test("the confirmation has the action line, the reason and the DM notice", async () => {
        const t = prefix("kick", [`<@${TARGET}>`, "bye"]);
        await t.run();
        const json = JSON.stringify((t.replies[0] as { components: { toJSON(): unknown }[] }).components.map((c) => c.toJSON()));
        expect(json).toContain(`✅ **Kicked** <@${TARGET}> (\`K7XQ2MP\`)`);
        expect(json).toContain("> **Reason:** r");
        expect(json).toContain("-# I couldn't DM this user, so they weren't told about this case.");
    });
});

describe("moderator stats", () => {
    const ctx = (sub: string | null, user: unknown) =>
        ({
            mode: "prefix",
            guild: { id: GUILD },
            user: { id: "mod" },
            member: { permissions: { has: () => true } },
            args: { getUser: async () => user, getSubcommand: () => sub },
            raw: { kind: "prefix" },
            defer: async () => {},
            reply: async (p: unknown) => void replies.push(p),
        }) as unknown as GuildCommandContext;
    const replies: unknown[] = [];
    const repo = { staffStats: async () => [] };
    const deps = { repo, service: {} } as unknown as ModCommandDeps;

    test("moderator stats replies with the stats text", async () => {
        replies.length = 0;
        await handlers.stats(ctx("stats", null), deps);
        expect(JSON.stringify(replies[0])).toContain("7 days");
    });
});

describe("mclear", () => {
    const ctx = (has: boolean) => {
        const sent: string[] = [];
        const channel = {
            bulkDelete: async () => ({ size: 0 }),
            permissionsFor: () => ({ has: () => has }),
            send: async (t: string) => {
                sent.push(t);
                return { delete: async () => {} };
            },
        };
        return {
            sent,
            ctx: {
                invokePrefix: "!",
                client: { user: { id: "bot" } },
                guild: { id: GUILD, members: { me: { id: "bot" } } },
                raw: { kind: "prefix", message: { channel } },
            } as unknown as GuildCommandContext,
        };
    };

    test("without Manage Messages it answers with a clear error", async () => {
        const t = ctx(false);
        await expect(handlers.mclear(t.ctx)).rejects.toThrow("I need Manage Messages here.");
        expect(t.sent).toEqual([]);
    });
});
