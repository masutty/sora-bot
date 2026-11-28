import { describe, expect, test } from "bun:test";
import { defaultSettings } from "../repository/settings.repository";
import type { CaseEventKind, CaseRow, ModSettings, Threshold } from "../types";
import { type CaseDeps, type CaseRepo, createCaseService } from "./case.service";

const G = "g1";
const MOD = "mod1";
const USER = "u1";
const T0 = new Date("2026-01-01T00:00:00Z");

export function makeHarness(
    opts: {
        settings?: Partial<ModSettings>;
        ladder?: Threshold[];
        dmOk?: boolean;
        refusal?: string | null;
        roleRefusal?: string | null;
    } = {},
) {
    const cases: CaseRow[] = [];
    const events: { caseId: string; kind: CaseEventKind; byId: string | null; data?: Record<string, unknown> }[] = [];
    const calls: string[] = [];
    const posts: unknown[] = [];
    let seq = 0;
    let clock = T0;
    const cfg: ModSettings = { ...defaultSettings(G), ...opts.settings };

    const repo: CaseRepo = {
        async insertCase(row) {
            calls.push("db:insert");
            const full: CaseRow = {
                id: row.id,
                guild_id: row.guild_id,
                kind: row.kind,
                user_id: row.user_id,
                moderator_id: row.moderator_id,
                reason: row.reason,
                weight: row.weight ?? 1,
                role_id: row.role_id ?? null,
                created_at: row.created_at ?? clock,
                expires_at: row.expires_at ?? null,
                ended_at: null,
                end_reason: null,
                ended_by: null,
                end_note: null,
                triggered_by: row.triggered_by ?? null,
                threshold_level: row.threshold_level ?? null,
                dm_delivered: row.dm_delivered ?? null,
                dm_error: row.dm_error ?? null,
            };
            cases.push(full);
            return { ...full };
        },
        async getCase(_g, id) {
            const row = cases.find((c) => c.id === id);
            return row ? { ...row } : null;
        },
        async activeWarns(_g, userId, now) {
            return cases.filter((c) => c.user_id === userId && c.kind === "warn" && !c.ended_at && (!c.expires_at || c.expires_at > now));
        },
        async activeOfKind(_g, userId, kind) {
            return cases.filter((c) => c.user_id === userId && c.kind === kind && !c.ended_at);
        },
        async endCase(id, end) {
            const row = cases.find((c) => c.id === id);
            if (!row || row.ended_at) return null;
            Object.assign(row, { ended_at: end.at, end_reason: end.reason, ended_by: end.by, end_note: end.note });
            return { ...row };
        },
        async reopenCase(id) {
            calls.push("db:reopen");
            const row = cases.find((c) => c.id === id);
            if (row) Object.assign(row, { ended_at: null, end_reason: null, ended_by: null, end_note: null });
        },
        async updateReason(id, reason) {
            const row = cases.find((c) => c.id === id);
            if (!row) return null;
            row.reason = reason;
            return { ...row };
        },
        async setDmDelivered(id, delivered) {
            const row = cases.find((c) => c.id === id);
            if (row) row.dm_delivered = delivered;
        },
        async insertEvent(e) {
            events.push(e);
        },
        async getSettings() {
            return cfg;
        },
        async getThresholds() {
            return opts.ladder ?? [];
        },
    };

    const deps: CaseDeps = {
        repo,
        now: () => clock,
        newId: () => `CASE${String(++seq).padStart(3, "0")}`,
        discord: {
            async timeout(_g, _u, ms) {
                calls.push(`timeout:${ms}`);
            },
            async kick() {
                calls.push("kick");
            },
            async ban(_g, _u, del) {
                calls.push(`ban:${del}`);
            },
            async unban() {
                calls.push("unban");
            },
            async addRole() {
                calls.push("addRole");
            },
            async removeRole() {
                calls.push("removeRole");
            },
            async dm() {
                calls.push("dm");
                return opts.dmOk === false ? "DMs closed" : null;
            },
            async postCaseChannel(channelId, payload) {
                calls.push(`post:${channelId}`);
                posts.push(payload);
                return { channelId, messageId: `m${posts.length}` };
            },
            async removeButtons(ref) {
                calls.push(`strip:${ref.messageId}`);
            },
            async isMember() {
                return true;
            },
            async canAct(_g, _m, _t, action) {
                calls.push(action ? `canAct:${action}` : "canAct");
                return opts.refusal ?? null;
            },
            async canGiveRole() {
                return opts.roleRefusal ?? null;
            },
            guildName: () => "Guild",
        },
    };
    return {
        deps,
        cases,
        events,
        calls,
        posts,
        service: createCaseService(deps),
        advance: (ms: number) => {
            clock = new Date(clock.getTime() + ms);
        },
    };
}

const target = { guildId: G, userId: USER, moderatorId: MOD };

describe("hierarchy", () => {
    test("a refusal throws before any database write", async () => {
        const h = makeHarness({ refusal: "You cannot act on that user." });
        await expect(h.service.ban(target)).rejects.toThrow("You cannot act on that user.");
        await expect(h.service.warn(target)).rejects.toThrow();
        expect(h.cases).toHaveLength(0);
        expect(h.calls).not.toContain("db:insert");
    });
});

describe("kick and ban", () => {
    test("the DM goes out before the action", async () => {
        for (const kind of ["kick", "ban"] as const) {
            const h = makeHarness();
            await h.service[kind](target);
            expect(h.calls.indexOf("dm")).toBeLessThan(h.calls.indexOf(kind === "kick" ? "kick" : "ban:0"));
        }
    });

    test("a failed DM never blocks the action and is recorded", async () => {
        const h = makeHarness({ dmOk: false });
        const row = await h.service.ban({ ...target, durationS: 3600 });
        expect(h.calls).toContain("ban:0");
        expect(row.dm_delivered).toBe(false);
        expect(h.cases[0]?.dm_delivered).toBe(false);
        expect(h.cases[0]?.dm_error).toBe("DMs closed");
        expect(row.expires_at?.getTime()).toBe(T0.getTime() + 3_600_000);
    });

    test("ban of a non-member sends no DM and leaves dm_delivered null", async () => {
        const h = makeHarness();
        h.deps.discord.isMember = async () => false;
        const row = await h.service.ban(target);
        expect(h.calls).not.toContain("dm");
        expect(row.dm_delivered).toBeNull();
    });

    test("softban bans with a day of deletion, then unbans", async () => {
        const h = makeHarness();
        await h.service.softban(target);
        expect(h.calls.filter((c) => c.startsWith("ban") || c === "unban")).toEqual(["ban:86400", "unban"]);
    });

    test("a failing action leaves no Case and no Case Channel post, and says why", async () => {
        const h = makeHarness({ settings: { case_channel_id: "cc" } });
        h.deps.discord.kick = async () => {
            throw Object.assign(new Error("Missing Permissions"), { code: 50013 });
        };
        await expect(h.service.kick(target)).rejects.toThrow(/missing a permission/);
        expect(h.cases).toHaveLength(0);
        expect(h.events).toHaveLength(0);
        expect(h.calls).not.toContain("post:cc");
    });

    test("an unknown failure passes through untouched", async () => {
        const h = makeHarness();
        h.deps.discord.ban = async () => {
            throw new Error("boom");
        };
        await expect(h.service.ban(target)).rejects.toThrow("boom");
        expect(h.cases).toHaveLength(0);
    });

    test("the bot side is checked for the action before the DM or any write", async () => {
        const h = makeHarness({ refusal: "I can't do that to this member." });
        for (const kind of ["kick", "ban", "softban"] as const) await expect(h.service[kind](target)).rejects.toThrow("I can't");
        await expect(h.service.mute({ ...target, durationS: 60 })).rejects.toThrow("I can't");
        expect(h.calls.filter((c) => c.startsWith("canAct"))).toEqual(["canAct:kick", "canAct:ban", "canAct:ban", "canAct:mute"]);
        expect(h.calls).not.toContain("dm");
        expect(h.calls).not.toContain("db:insert");
    });

    test("the Case is stored after the DM and the action", async () => {
        const h = makeHarness();
        await h.service.kick(target);
        expect(h.calls.filter((c) => ["dm", "kick", "db:insert"].includes(c))).toEqual(["dm", "kick", "db:insert"]);
    });

    test("the reason goes to the audit log", async () => {
        const h = makeHarness();
        const seen: (string | undefined)[] = [];
        h.deps.discord.kick = async (_g, _u, reason) => void seen.push(reason);
        h.deps.discord.timeout = async (_g, _u, _ms, reason) => void seen.push(reason);
        h.deps.discord.ban = async (_g, _u, _d, reason) => void seen.push(reason);
        await h.service.kick({ ...target, reason: "a" });
        await h.service.mute({ ...target, reason: "b", durationS: 60 });
        await h.service.ban({ ...target, reason: "c" });
        expect(seen).toEqual(["a", "b", "c"]);
    });

    test("only a ban works on a user who is not in the server", async () => {
        const h = makeHarness();
        h.deps.discord.isMember = async () => false;
        for (const kind of ["mute", "kick", "softban"] as const) {
            await expect(h.service[kind]({ ...target, durationS: 60 })).rejects.toThrow("not in this server");
        }
        await expect(h.service.warn(target)).rejects.toThrow("not in this server");
        expect(h.calls).not.toContain("dm");
        expect(h.cases).toHaveLength(0);
    });

    test("durations and reasons are capped", async () => {
        const h = makeHarness();
        await expect(h.service.ban({ ...target, durationS: 366 * 86400 })).rejects.toThrow(/at most/);
        await expect(h.service.kick({ ...target, reason: "x".repeat(1001) })).rejects.toThrow(/1000/);
        await expect(h.service.warn({ ...target, weight: 101 })).rejects.toThrow();
        await expect(h.service.mute({ ...target, durationS: 28 * 86400 })).rejects.toThrow();
        expect(h.cases).toHaveLength(0);
    });
});

describe("mute and replace", () => {
    test("mute is capped at 28 days and needs a duration", async () => {
        const h = makeHarness();
        await expect(h.service.mute({ ...target, durationS: 29 * 86400 })).rejects.toThrow();
        await expect(h.service.mute({ ...target, durationS: 0 })).rejects.toThrow();
    });

    test("a new mute replaces the active one", async () => {
        const h = makeHarness();
        const first = await h.service.mute({ ...target, durationS: 600 });
        const second = await h.service.mute({ ...target, durationS: 1200 });
        expect(h.cases.find((c) => c.id === first.id)?.end_reason).toBe("replaced");
        expect(h.cases.find((c) => c.id === second.id)?.ended_at).toBeNull();
        expect(h.events.some((e) => e.caseId === first.id && e.kind === "replaced")).toBe(true);
    });

    test("the Case Channel hears Created before Replaced", async () => {
        const h = makeHarness();
        await h.service.mute({ ...target, durationS: 600 });
        h.events.length = 0;
        await h.service.mute({ ...target, durationS: 1200 });
        expect(h.events.map((e) => e.kind)).toEqual(["created", "replaced"]);
    });

    test("a case id collision retries with a new id", async () => {
        const h = makeHarness();
        const real = h.deps.repo.insertCase;
        let first = true;
        h.deps.repo.insertCase = async (row) => {
            if (first) {
                first = false;
                throw Object.assign(new Error("dup"), { code: "23505" });
            }
            return real(row);
        };
        const row = await h.service.warn(target);
        expect(row.case.id).toBe("CASE002");
    });
});

describe("temprole", () => {
    test("adds the role, records expiry and sends no DM", async () => {
        const h = makeHarness();
        const row = await h.service.temprole({ ...target, durationS: 60, roleId: "r1" });
        expect(h.calls).toContain("addRole");
        expect(h.calls).not.toContain("dm");
        expect(row.role_id).toBe("r1");
    });

    test("a role the actor or bot may not give is refused before anything happens", async () => {
        const h = makeHarness({ roleRefusal: "Your highest role is not above that role." });
        await expect(h.service.temprole({ ...target, durationS: 60, roleId: "r1" })).rejects.toThrow("not above that role");
        expect(h.calls).not.toContain("addRole");
        expect(h.cases).toHaveLength(0);
    });
});

describe("warn and Auto-Punishment", () => {
    const ladder: Threshold[] = [
        { warns: 2, action: "mute", durationS: 3600 },
        { warns: 3, action: null, durationS: null },
        { warns: 5, action: "ban", durationS: null },
    ];

    test("auto off: a warn only creates the warn", async () => {
        const h = makeHarness({ ladder });
        const res = await h.service.warn({ ...target, weight: 3 });
        expect(res.auto).toBeNull();
        expect(h.cases).toHaveLength(1);
    });

    test("a jump over several thresholds fires the highest once, as the bot, linked to the warn", async () => {
        const h = makeHarness({ ladder, settings: { auto_enabled: true } });
        const res = await h.service.warn({ ...target, weight: 3 });
        expect(res.auto?.kind).toBe("mute");
        expect(res.auto?.moderator_id).toBeNull();
        expect(res.auto?.reason).toBe("Reached 2 active warns");
        expect(res.auto?.triggered_by).toBe(res.case.id);
        expect(res.auto?.threshold_level).toBe(2);
        expect(h.cases.filter((c) => c.kind === "mute")).toHaveLength(1);
    });

    test("a later warn at the same level does not re-fire", async () => {
        const h = makeHarness({ ladder, settings: { auto_enabled: true } });
        await h.service.warn({ ...target, weight: 2 });
        const res = await h.service.warn(target);
        expect(res.auto).toBeNull();
        expect(h.cases.filter((c) => c.kind === "mute")).toHaveLength(1);
    });

    test("a refused Auto-Punishment leaves the warn standing", async () => {
        const h = makeHarness({ ladder, settings: { auto_enabled: true } });
        h.deps.discord.canAct = async (_g, moderatorId) => (moderatorId === null ? "Bot is below the target." : null);
        const res = await h.service.warn({ ...target, weight: 2 });
        expect(res.auto).toBeNull();
        expect(res.autoSkipped).toContain("Bot is below the target.");
        expect(h.cases).toHaveLength(1);
    });

    test("unwarn with auto-undo revokes the Auto-Punishment, attributed to the unwarn author", async () => {
        const h = makeHarness({ ladder, settings: { auto_enabled: true, auto_undo: true } });
        const res = await h.service.warn({ ...target, weight: 2 });
        const out = await h.service.unwarn({ guildId: G, caseId: res.case.id, by: "other", reason: "mistake" });
        expect(out.undone).toHaveLength(1);
        const mute = h.cases.find((c) => c.id === res.auto?.id);
        expect(mute?.end_reason).toBe("revoked");
        expect(mute?.ended_by).toBe("other");
        expect(mute?.end_note).toBe(`Warn \`${res.case.id}\` revoked`);
        expect(h.calls).toContain("timeout:null");
        expect(h.events.some((e) => e.caseId === mute?.id && e.kind === "auto_undone")).toBe(true);
    });

    test("unwarn with auto-undo off leaves the Auto-Punishment", async () => {
        const h = makeHarness({ ladder, settings: { auto_enabled: true, auto_undo: false } });
        const res = await h.service.warn({ ...target, weight: 2 });
        const out = await h.service.unwarn({ guildId: G, caseId: res.case.id, by: "other" });
        expect(out.undone).toHaveLength(0);
        expect(h.cases.find((c) => c.id === res.auto?.id)?.ended_at).toBeNull();
    });

    test("unwarn that keeps the weight at the level undoes nothing", async () => {
        const h = makeHarness({ ladder, settings: { auto_enabled: true } });
        await h.service.warn({ ...target, weight: 2 });
        const extra = await h.service.warn(target);
        const out = await h.service.unwarn({ guildId: G, caseId: extra.case.id, by: "other" });
        expect(out.undone).toHaveLength(0);
    });

    test("nobody revokes a warn of their own", async () => {
        const h = makeHarness();
        const warn = await h.service.warn(target);
        await expect(h.service.unwarn({ guildId: G, caseId: warn.case.id, by: USER })).rejects.toThrow("yourself");
    });

    test("a bot owner may warn and unwarn themselves, with no hierarchy check", async () => {
        const h = makeHarness({ refusal: "You can't do that to yourself." });
        const service = createCaseService({ ...h.deps, isBotOwner: (id) => id === MOD });
        const self = { guildId: G, userId: MOD, moderatorId: MOD };
        const warn = await service.warn(self);
        expect(h.calls).not.toContain("canAct");
        await service.unwarn({ guildId: G, caseId: warn.case.id, by: MOD });
        await expect(h.service.warn(self)).rejects.toThrow("yourself");
    });

    test("auto-undo ignores a member who left", async () => {
        const h = makeHarness({ ladder, settings: { auto_enabled: true, auto_undo: true } });
        const res = await h.service.warn({ ...target, weight: 2 });
        h.deps.discord.timeout = async () => {
            throw Object.assign(new Error("Unknown Member"), { code: 10007 });
        };
        const out = await h.service.unwarn({ guildId: G, caseId: res.case.id, by: "other" });
        expect(out.undone).toHaveLength(1);
    });

    test("unwarn rejects non-warns and already ended warns", async () => {
        const h = makeHarness();
        const mute = await h.service.mute({ ...target, durationS: 60 });
        await expect(h.service.unwarn({ guildId: G, caseId: mute.id, by: MOD })).rejects.toThrow();
        const warn = await h.service.warn(target);
        await h.service.unwarn({ guildId: G, caseId: warn.case.id, by: MOD });
        await expect(h.service.unwarn({ guildId: G, caseId: warn.case.id, by: MOD })).rejects.toThrow();
    });
});

describe("untemprole", () => {
    test("removes the role, revokes the case with author and reason, no DM", async () => {
        const h = makeHarness();
        await h.service.temprole({ ...target, durationS: 60, roleId: "r1" });
        h.calls.length = 0;
        const ended = await h.service.untemprole({ guildId: G, userId: USER, roleId: "r1", by: MOD, reason: "oops" });
        expect(ended).toHaveLength(1);
        expect(ended[0]).toMatchObject({ end_reason: "revoked", ended_by: MOD, end_note: "oops" });
        expect(h.calls).toContain("removeRole");
        expect(h.calls).not.toContain("dm");
        expect(h.events.at(-1)?.kind).toBe("revoked");
    });

    test("no active temprole for that role is refused", async () => {
        const h = makeHarness();
        await h.service.temprole({ ...target, durationS: 60, roleId: "r1" });
        await expect(h.service.untemprole({ guildId: G, userId: USER, roleId: "r2", by: MOD })).rejects.toThrow(
            "<@u1> has no temporary <@&r2>.",
        );
    });

    test("ignores a member who left", async () => {
        const h = makeHarness();
        await h.service.temprole({ ...target, durationS: 60, roleId: "r1" });
        h.deps.discord.removeRole = async () => {
            throw Object.assign(new Error("Unknown Member"), { code: 10007 });
        };
        const ended = await h.service.untemprole({ guildId: G, userId: USER, roleId: "r1", by: MOD });
        expect(ended[0]?.end_reason).toBe("revoked");
    });
});

describe("unmute, unban, editReason", () => {
    test("unmute lifts the timeout and revokes the case", async () => {
        const h = makeHarness();
        await h.service.mute({ ...target, durationS: 600 });
        const ended = await h.service.unmute({ guildId: G, userId: USER, by: MOD });
        expect(ended[0]?.end_reason).toBe("revoked");
        expect(h.calls).toContain("timeout:null");
        await expect(h.service.unmute({ guildId: G, userId: USER, by: MOD })).rejects.toThrow();
    });

    test("unmute ignores a member who left", async () => {
        const h = makeHarness();
        await h.service.mute({ ...target, durationS: 600 });
        h.deps.discord.timeout = async () => {
            throw Object.assign(new Error("Unknown Member"), { code: 10007 });
        };
        const ended = await h.service.unmute({ guildId: G, userId: USER, by: MOD });
        expect(ended[0]?.end_reason).toBe("revoked");
    });

    test("unban of someone not banned and without a case is refused", async () => {
        const h = makeHarness();
        h.deps.discord.unban = async () => {
            throw Object.assign(new Error("Unknown Ban"), { code: 10026 });
        };
        await expect(h.service.unban({ guildId: G, userId: USER, by: MOD })).rejects.toThrow("not banned");
    });

    test("unban of a user who is not in the server sends no DM", async () => {
        const h = makeHarness();
        h.deps.discord.isMember = async () => false;
        await h.service.ban(target);
        const ended = await h.service.unban({ guildId: G, userId: USER, by: MOD });
        expect(ended[0]?.end_reason).toBe("revoked");
        expect(h.calls).not.toContain("dm");
    });

    test("reason edit creates an event with the old and new text and posts to the Case Channel", async () => {
        const h = makeHarness({ settings: { case_channel_id: "cc" } });
        const warn = await h.service.warn({ ...target, reason: "old" });
        const updated = await h.service.editReason({ guildId: G, caseId: warn.case.id, reason: "new", by: "other" });
        expect(updated.reason).toBe("new");
        expect(h.events.at(-1)).toMatchObject({ kind: "reason_changed", byId: "other", data: { from: "old", to: "new" } });
        expect(h.calls.filter((c) => c === "post:cc")).toHaveLength(2);
    });
});

describe("expire", () => {
    test("ban: unbans and records; mute: records without touching Discord", async () => {
        const h = makeHarness();
        const ban = await h.service.ban({ ...target, durationS: 60 });
        h.calls.length = 0;
        const ended = await h.service.expire(ban);
        expect(ended?.end_reason).toBe("expired");
        expect(h.calls).toContain("unban");
        expect(h.calls).toContain("dm");

        const mute = await h.service.mute({ ...target, durationS: 60 });
        h.calls.length = 0;
        await h.service.expire(mute);
        expect(h.calls).not.toContain("timeout:null");
    });

    test("already ended: nothing is repeated", async () => {
        const h = makeHarness();
        const warn = await h.service.warn(target);
        await h.service.expire(warn.case);
        h.calls.length = 0;
        expect(await h.service.expire(warn.case)).toBeNull();
        expect(h.calls).not.toContain("dm");
    });

    test("temprole: removes the role, ignores a missing member, no DM", async () => {
        const h = makeHarness();
        const row = await h.service.temprole({ ...target, durationS: 60, roleId: "r1" });
        h.deps.discord.removeRole = async () => {
            throw Object.assign(new Error("Unknown Member"), { code: 10007 });
        };
        h.calls.length = 0;
        const ended = await h.service.expire(row);
        expect(ended?.end_reason).toBe("expired");
        expect(h.calls).not.toContain("dm");
    });

    test("claims the case before lifting: an already ended ban is not unbanned", async () => {
        const h = makeHarness();
        const ban = await h.service.ban({ ...target, durationS: 60 });
        await h.service.expire(ban);
        h.calls.length = 0;
        expect(await h.service.expire(ban)).toBeNull();
        expect(h.calls).not.toContain("unban");
    });

    test("a lift that can never work still ends the case, with a note", async () => {
        for (const code of [50013, "GUILD_NOT_CACHED"]) {
            const h = makeHarness();
            const ban = await h.service.ban({ ...target, durationS: 60 });
            h.deps.discord.unban = async () => {
                throw Object.assign(new Error("no"), { code });
            };
            const ended = await h.service.expire(ban);
            expect(ended?.end_reason).toBe("expired");
            expect(h.events.at(-1)?.data?.note).toMatch(/Couldn't lift/);
            expect(h.calls).not.toContain("db:reopen");
        }
    });

    test("a lift that fails for another reason reopens the case for the next tick", async () => {
        const h = makeHarness();
        const ban = await h.service.ban({ ...target, durationS: 60 });
        h.deps.discord.unban = async () => {
            throw new Error("network");
        };
        await expect(h.service.expire(ban)).rejects.toThrow("network");
        expect(h.cases[0]?.ended_at).toBeNull();
    });
});

describe("undo buttons", () => {
    test("ending a case edits its remembered Created post once", async () => {
        const h = makeHarness({ settings: { case_channel_id: "cc" } });
        const { case: warn } = await h.service.warn(target);
        expect(h.calls).not.toContain("strip:m1");
        await h.service.unwarn({ guildId: G, caseId: warn.id, by: MOD });
        expect(h.calls.filter((c) => c === "strip:m1")).toHaveLength(1);
    });

    test("a kick leaves nothing to edit", async () => {
        const h = makeHarness({ settings: { case_channel_id: "cc" } });
        await h.service.kick(target);
        expect(h.calls.some((c) => c.startsWith("strip:"))).toBe(false);
    });
});
