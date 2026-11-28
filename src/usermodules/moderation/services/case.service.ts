import { type MessageCreateOptions, RESTJSONErrorCodes } from "discord.js";
import { formatTime } from "@/utils/format";
import { Logger } from "@/utils/logging";
import type { NewCase } from "../repository/cases.repository";
import { settings } from "../settings";
import {
    type CaseEventKind,
    type CaseKind,
    type CaseRow,
    type EndReason,
    ModerationError,
    type ModSettings,
    type Threshold,
} from "../types";
import { firedThreshold, undoneBy } from "./ladder";
import { type CaseChannelEvent, caseChannelPayload, type DmEvent, dmPayload } from "./payloads";
import { UNDO_LABELS } from "./undo";
import { createUndoTracker, type PostRef } from "./undo-tracker";

const logger = new Logger("moderation.case");

/** Set on the error of a guild the bot no longer has cached, so the expiry worker knows retrying is useless. */
export const GUILD_NOT_CACHED = "GUILD_NOT_CACHED";

/** Postgres unique violation - a Case ID collision. */
const UNIQUE_VIOLATION = "23505";
const ID_RETRIES = 5;

export interface CaseRepo {
    insertCase(row: NewCase): Promise<CaseRow>;
    getCase(guildId: string, id: string): Promise<CaseRow | null>;
    activeWarns(guildId: string, userId: string, now: Date): Promise<CaseRow[]>;
    activeOfKind(guildId: string, userId: string, kind: CaseKind): Promise<CaseRow[]>;
    endCase(id: string, end: { reason: EndReason; by: string | null; note: string | null; at: Date }): Promise<CaseRow | null>;
    reopenCase(id: string): Promise<void>;
    updateReason(id: string, reason: string): Promise<CaseRow | null>;
    setDmDelivered(id: string, delivered: boolean): Promise<void>;
    insertEvent(event: {
        caseId: string;
        kind: CaseEventKind;
        byId: string | null;
        data?: Record<string, unknown>;
        at?: Date;
    }): Promise<unknown>;
    getSettings(guildId: string): Promise<ModSettings>;
    getThresholds(guildId: string): Promise<Threshold[]>;
}

export interface CaseDiscord {
    /** `null` lifts the timeout. */
    timeout(guildId: string, userId: string, ms: number | null, reason?: string): Promise<void>;
    kick(guildId: string, userId: string, reason?: string): Promise<void>;
    ban(guildId: string, userId: string, deleteSeconds: number, reason?: string): Promise<void>;
    unban(guildId: string, userId: string): Promise<void>;
    addRole(guildId: string, userId: string, roleId: string): Promise<void>;
    removeRole(guildId: string, userId: string, roleId: string): Promise<void>;
    /** `true` when the DM arrived. */
    /** Resolves to `null` when delivered, else a short reason it failed. */
    dm(userId: string, payload: MessageCreateOptions): Promise<string | null>;
    /** Resolves to where the post landed, so its undo button can be removed later. */
    // biome-ignore lint/suspicious/noConfusingVoidType: test doubles may return nothing
    postCaseChannel(channelId: string, payload: MessageCreateOptions): Promise<PostRef | void>;
    /** Edits a Case Channel post to keep its container and drop the buttons. */
    removeButtons?(ref: PostRef): Promise<void>;
    /** Whether the user is in the server. */
    isMember(guildId: string, userId: string): Promise<boolean>;
    /**
     * `null` when the actor may act on the target, else the refusal text. `moderatorId` null is the
     * bot itself (Auto-Punishment): only the bot's own hierarchy is checked. `action` also checks
     * that the bot itself can do it to that member (it can be missing the permission).
     */
    canAct(guildId: string, moderatorId: string | null, targetId: string, action?: "mute" | "kick" | "ban"): Promise<string | null>;
    /** `null` when the role may be given to the member, else the refusal text. */
    canGiveRole(guildId: string, moderatorId: string, userId: string, roleId: string): Promise<string | null>;
    guildName(guildId: string): string;
}

export interface CaseDeps {
    repo: CaseRepo;
    discord: CaseDiscord;
    now(): Date;
    newId(): string;
    /** Bot owners may warn and unwarn themselves, to test the module. */
    isBotOwner?(userId: string): boolean;
}

interface Target {
    guildId: string;
    userId: string;
    moderatorId: string;
    reason?: string;
}

export interface WarnResult {
    case: CaseRow;
    /** The Auto-Punishment this warn fired, if any. */
    auto: CaseRow | null;
    /** Why a fired Auto-Punishment did not happen, if it did not. */
    autoSkipped: string | null;
}

export interface CaseService {
    warn(input: Target & { weight?: number }): Promise<WarnResult>;
    mute(input: Target & { durationS: number }): Promise<CaseRow>;
    kick(input: Target): Promise<CaseRow>;
    ban(input: Target & { durationS?: number | null }): Promise<CaseRow>;
    softban(input: Target): Promise<CaseRow>;
    temprole(input: Target & { durationS: number; roleId: string }): Promise<CaseRow>;
    /** Revokes a warn; with auto-undo on, also revokes Auto-Punishments that no longer hold. */
    unwarn(input: { guildId: string; caseId: string; by: string; reason?: string }): Promise<{ case: CaseRow; undone: CaseRow[] }>;
    /** Takes a temprole away early: removes the role and revokes its active Cases. No DM. */
    untemprole(input: { guildId: string; userId: string; roleId: string; by: string; reason?: string }): Promise<CaseRow[]>;
    unmute(input: { guildId: string; userId: string; by: string; reason?: string }): Promise<CaseRow[]>;
    unban(input: { guildId: string; userId: string; by: string; reason?: string }): Promise<CaseRow[]>;
    editReason(input: { guildId: string; caseId: string; reason: string; by: string }): Promise<CaseRow>;
    /** Ends a due case (worker); `null` when it was already ended. */
    expire(row: CaseRow): Promise<CaseRow | null>;
}

const codeOf = (err: unknown): unknown => (typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined);
/** What a DM attempt leaves on the Case. */
type DmOutcome = Pick<CaseRow, "dm_delivered" | "dm_error">;

const asError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

/** Runs `fn`, treating the given Discord error codes as "already done". */
async function ignoring(codes: number[], fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
    } catch (err) {
        if (!codes.includes(codeOf(err) as number)) throw err;
    }
}

/** What a Discord refusal means for the moderator. */
const DISCORD_REFUSALS: Record<number, string> = {
    [RESTJSONErrorCodes.MissingPermissions]: "Discord refused it: I'm missing a permission, or my role is too low.",
    [RESTJSONErrorCodes.UnknownMember]: "That user is not in this server.",
    [RESTJSONErrorCodes.UnknownUser]: "Discord doesn't know that user.",
    [RESTJSONErrorCodes.UnknownRole]: "That role no longer exists.",
};

/** Runs a Discord action; a known refusal becomes a ModerationError, anything else passes through. */
async function act<T>(fn: () => Promise<T>): Promise<T> {
    try {
        return await fn();
    } catch (err) {
        const message = DISCORD_REFUSALS[codeOf(err) as number];
        throw message ? new ModerationError(message) : err;
    }
}

/** Why a due case could not be lifted for good (so it ends anyway), or `null` when the failure may pass. */
function permanentFailure(err: unknown): string | null {
    if (codeOf(err) === GUILD_NOT_CACHED) return "the bot is no longer in the server";
    if (codeOf(err) === RESTJSONErrorCodes.MissingPermissions) return "the bot lacks permission";
    return null;
}

const sumWeight = (warns: CaseRow[]): number => warns.reduce((sum, w) => sum + w.weight, 0);

/** The reason to store: the default when none, refused when too long. */
function reasonText(reason: string | undefined): string {
    const text = reason ?? settings.defaultReason;
    if (text.length > settings.maxReason) throw new ModerationError(`A reason holds ${settings.maxReason} characters at most.`);
    return text;
}

function checkDuration(durationS: number, max: number, what: string): void {
    if (!Number.isInteger(durationS) || durationS <= 0) throw new ModerationError(`Give ${what} duration.`);
    if (durationS > max) throw new ModerationError(`${what[0]?.toUpperCase()}${what.slice(1)} duration is ${formatTime(max)} at most.`);
}

type Action = "mute" | "kick" | "ban";

export function createCaseService(deps: CaseDeps): CaseService {
    const { repo, discord } = deps;

    const undoPosts = createUndoTracker(async (ref) => void (await discord.removeButtons?.(ref)));

    async function post(cfg: ModSettings, event: CaseChannelEvent): Promise<void> {
        if (!cfg.case_channel_id) return;
        try {
            const ref = await discord.postCaseChannel(cfg.case_channel_id, caseChannelPayload(event));
            if (event.event === "created") {
                if (ref && UNDO_LABELS[event.case.kind]) undoPosts.remember(event.case.id, ref);
            } else if (event.event !== "reason_changed") await undoPosts.release(event.case.id);
        } catch (err) {
            logger.error(asError(err), { caseId: event.case.id });
        }
    }

    /** A DM failure never blocks anything - it only reads as "not delivered". Someone not in the server is never DMed. */
    async function sendDm(cfg: ModSettings, guildId: string, userId: string, event: DmEvent): Promise<DmOutcome> {
        if (!(await discord.isMember(guildId, userId))) return { dm_delivered: null, dm_error: null };
        let error: string | null;
        try {
            error = await discord.dm(
                userId,
                dmPayload(event, { guildId, guildName: discord.guildName(guildId), appealLine: cfg.appeal_line }),
            );
        } catch {
            error = "Couldn't send";
        }
        return { dm_delivered: error === null, dm_error: error };
    }

    /** The row as it will be stored, built before the action so the DM can carry its ID. */
    function draftCase(fields: Omit<NewCase, "id" | "created_at">, now: Date): CaseRow {
        return {
            weight: 1,
            role_id: null,
            expires_at: null,
            triggered_by: null,
            threshold_level: null,
            dm_delivered: null,
            dm_error: null,
            ...fields,
            id: deps.newId(),
            created_at: now,
            ended_at: null,
            end_reason: null,
            ended_by: null,
            end_note: null,
        };
    }

    /** Stores the draft; only an ID collision (rare) gives it a new ID. */
    async function insertDraft(draft: CaseRow): Promise<CaseRow> {
        for (let attempt = 1; ; attempt++) {
            try {
                return await repo.insertCase(attempt === 1 ? draft : { ...draft, id: deps.newId() });
            } catch (err) {
                if (codeOf(err) !== UNIQUE_VIOLATION || attempt >= ID_RETRIES) throw err;
            }
        }
    }

    /** A bot owner warning (or unwarning) themselves: allowed for tests, with no hierarchy check. */
    const selfTest = (userId: string, moderatorId: string | null) => userId === moderatorId && (deps.isBotOwner?.(userId) ?? false);

    async function refuse(guildId: string, moderatorId: string | null, userId: string, action?: Action): Promise<void> {
        const refusal = await discord.canAct(guildId, moderatorId, userId, action);
        if (refusal) throw new ModerationError(refusal);
    }

    /** Ends an open case, records the event and tells the Case Channel; `null` if it was already ended. */
    async function finish(
        cfg: ModSettings,
        row: CaseRow,
        end: { reason: EndReason; by: string | null; note: string | null },
        eventKind: CaseEventKind,
    ): Promise<CaseRow | null> {
        const at = deps.now();
        const ended = await repo.endCase(row.id, { ...end, at });
        if (!ended) return null;
        await repo.insertEvent({ caseId: row.id, kind: eventKind, byId: end.by, data: end.note ? { note: end.note } : {}, at });
        await post(cfg, { event: eventKind, case: ended, by: end.by, note: end.note, at });
        return ended;
    }

    /** Ends each case and DMs the member the reason. */
    async function endAll(
        cfg: ModSettings,
        rows: CaseRow[],
        by: string,
        note: string,
        eventKind: CaseEventKind = "revoked",
    ): Promise<CaseRow[]> {
        const ended: CaseRow[] = [];
        for (const row of rows) {
            const done = await finish(cfg, row, { reason: "revoked", by, note }, eventKind);
            if (!done) continue;
            await sendDm(cfg, row.guild_id, row.user_id, { type: "ended", case: done, reason: note });
            ended.push(done);
        }
        return ended;
    }

    /** Records the new case, then replaces the open ones of the same kind. */
    async function record(cfg: ModSettings, row: CaseRow, moderatorId: string | null, prior: CaseRow[] = []): Promise<void> {
        await repo.insertEvent({ caseId: row.id, kind: "created", byId: moderatorId, at: row.created_at });
        await post(cfg, { event: "created", case: row, by: moderatorId });
        for (const old of prior) {
            await finish(cfg, old, { reason: "replaced", by: moderatorId, note: `Replaced by \`${row.id}\`` }, "replaced");
        }
    }

    async function punish(
        kind: "mute" | "kick" | "ban" | "softban",
        input: Omit<Target, "moderatorId"> & {
            moderatorId: string | null;
            durationS?: number | null;
            triggeredBy?: string;
            thresholdLevel?: number;
        },
    ): Promise<CaseRow> {
        const { guildId, userId, moderatorId } = input;
        const reason = reasonText(input.reason);
        await refuse(guildId, moderatorId, userId, kind === "softban" ? "ban" : kind);
        const durationS = input.durationS ?? null;
        if (kind === "mute") checkDuration(durationS ?? 0, settings.maxMuteSeconds, "a mute");
        if (kind === "ban" && durationS !== null) checkDuration(durationS, settings.maxLongSeconds, "a ban");
        const member = await discord.isMember(guildId, userId);
        // Only a ban works on someone who already left; it never DMs them.
        if (kind !== "ban" && !member) throw new ModerationError("That user is not in this server.");

        const cfg = await repo.getSettings(guildId);
        const now = deps.now();
        const prior = kind === "mute" || kind === "ban" ? await repo.activeOfKind(guildId, userId, kind) : [];
        const draft = draftCase(
            {
                guild_id: guildId,
                kind,
                user_id: userId,
                moderator_id: moderatorId,
                reason,
                expires_at: durationS === null ? null : new Date(now.getTime() + durationS * 1000),
                triggered_by: input.triggeredBy ?? null,
                threshold_level: input.thresholdLevel ?? null,
            },
            now,
        );

        // The DM goes out before a kick or ban: afterwards the bot shares no server with the user.
        const dmFirst = kind !== "mute";
        let dm: DmOutcome | null = null;
        if (dmFirst && member) dm = await sendDm(cfg, guildId, userId, { type: "punished", case: draft });
        await act(async () => {
            if (kind === "mute") await discord.timeout(guildId, userId, (durationS as number) * 1000, reason);
            else if (kind === "kick") await discord.kick(guildId, userId, reason);
            else if (kind === "ban") await discord.ban(guildId, userId, 0, reason);
            else {
                await discord.ban(guildId, userId, settings.softbanDeleteSeconds, reason);
                await discord.unban(guildId, userId);
            }
        });
        if (!dmFirst && member) dm = await sendDm(cfg, guildId, userId, { type: "punished", case: draft });

        // Only an action that happened leaves a Case.
        const row = await insertDraft({ ...draft, ...dm });
        await record(cfg, row, moderatorId, prior);
        return row;
    }

    async function runAuto(warn: CaseRow, weightBefore: number, weightAfter: number): Promise<Pick<WarnResult, "auto" | "autoSkipped">> {
        const fired = firedThreshold(await repo.getThresholds(warn.guild_id), weightBefore, weightAfter);
        if (!fired?.action) return { auto: null, autoSkipped: null };
        const base = {
            guildId: warn.guild_id,
            userId: warn.user_id,
            moderatorId: null,
            reason: `Reached ${fired.warns} active warns`,
            triggeredBy: warn.id,
            thresholdLevel: fired.warns,
        };
        const durationS =
            fired.action === "mute"
                ? Math.min(fired.durationS ?? settings.maxMuteSeconds, settings.maxMuteSeconds)
                : fired.action === "ban"
                  ? fired.durationS
                  : null;
        try {
            return { auto: await punish(fired.action, { ...base, durationS }), autoSkipped: null };
        } catch (err) {
            // The warn already stands; a refused or failed Auto-Punishment must not undo it.
            logger.error(asError(err), { caseId: warn.id });
            const why = err instanceof ModerationError ? err.message : "Discord refused it.";
            return { auto: null, autoSkipped: `Auto-Punishment didn't ${fired.action} them at ${fired.warns} warns: ${why}` };
        }
    }

    /** Lifts what a due case holds on Discord. */
    async function lift(row: CaseRow): Promise<void> {
        if (row.kind === "ban") await ignoring([RESTJSONErrorCodes.UnknownBan], () => discord.unban(row.guild_id, row.user_id));
        if (row.kind === "temprole" && row.role_id) {
            const roleId = row.role_id;
            await ignoring([RESTJSONErrorCodes.UnknownMember, RESTJSONErrorCodes.UnknownRole], () =>
                discord.removeRole(row.guild_id, row.user_id, roleId),
            );
        }
    }

    return {
        async warn(input) {
            const { guildId, userId, moderatorId } = input;
            const weight = input.weight ?? 1;
            if (!Number.isInteger(weight) || weight < 1 || weight > settings.maxWeight) {
                throw new ModerationError(`A warn weighs 1 to ${settings.maxWeight}.`);
            }
            const reason = reasonText(input.reason);
            if (!selfTest(userId, moderatorId)) await refuse(guildId, moderatorId, userId);
            if (!(await discord.isMember(guildId, userId))) throw new ModerationError("That user is not in this server.");
            const cfg = await repo.getSettings(guildId);
            const now = deps.now();
            const draft = draftCase(
                {
                    guild_id: guildId,
                    kind: "warn",
                    user_id: userId,
                    moderator_id: moderatorId,
                    reason,
                    weight,
                    expires_at: new Date(now.getTime() + cfg.warn_expiry_days * 86_400_000),
                },
                now,
            );
            const dm = await sendDm(cfg, guildId, userId, { type: "punished", case: draft });
            const row = await insertDraft({ ...draft, ...dm });
            await record(cfg, row, moderatorId);

            if (!cfg.auto_enabled) return { case: row, auto: null, autoSkipped: null };
            const after = sumWeight(await repo.activeWarns(guildId, userId, now));
            return { case: row, ...(await runAuto(row, after - weight, after)) };
        },

        mute: (input) => punish("mute", input),
        kick: (input) => punish("kick", input),
        ban: (input) => punish("ban", input),
        softban: (input) => punish("softban", input),

        async temprole(input) {
            const { guildId, userId, moderatorId, roleId, durationS } = input;
            const reason = reasonText(input.reason);
            checkDuration(durationS, settings.maxLongSeconds, "a");
            await refuse(guildId, moderatorId, userId);
            if (!(await discord.isMember(guildId, userId))) throw new ModerationError("That user is not in this server.");
            const roleRefusal = await discord.canGiveRole(guildId, moderatorId, userId, roleId);
            if (roleRefusal) throw new ModerationError(roleRefusal);
            const cfg = await repo.getSettings(guildId);
            const now = deps.now();
            const draft = draftCase(
                {
                    guild_id: guildId,
                    kind: "temprole",
                    user_id: userId,
                    moderator_id: moderatorId,
                    reason,
                    role_id: roleId,
                    expires_at: new Date(now.getTime() + durationS * 1000),
                },
                now,
            );
            await act(() => discord.addRole(guildId, userId, roleId));
            const row = await insertDraft(draft);
            await record(cfg, row, moderatorId);
            return row;
        },

        async unwarn({ guildId, caseId, by, reason }) {
            const note = reasonText(reason);
            const warn = await repo.getCase(guildId, caseId);
            if (!warn || warn.kind !== "warn") throw new ModerationError(`No warn \`${caseId}\`.`);
            if (warn.user_id === by && !selfTest(warn.user_id, by)) throw new ModerationError("You can't do that to yourself.");
            if (warn.ended_at) throw new ModerationError(`Warn \`${caseId}\` already ended.`);
            const cfg = await repo.getSettings(guildId);
            const [ended] = await endAll(cfg, [warn], by, note);
            if (!ended) throw new ModerationError(`Warn \`${caseId}\` already ended.`);

            const undone: CaseRow[] = [];
            if (cfg.auto_undo) {
                const weight = sumWeight(await repo.activeWarns(guildId, warn.user_id, deps.now()));
                const open = [
                    ...(await repo.activeOfKind(guildId, warn.user_id, "mute")),
                    ...(await repo.activeOfKind(guildId, warn.user_id, "ban")),
                ];
                for (const punishment of open) {
                    if (punishment.triggered_by === null || !undoneBy(punishment, weight)) continue;
                    if (punishment.kind === "mute") {
                        await ignoring([RESTJSONErrorCodes.UnknownMember], () => discord.timeout(guildId, warn.user_id, null));
                    } else await ignoring([RESTJSONErrorCodes.UnknownBan], () => discord.unban(guildId, warn.user_id));
                    undone.push(...(await endAll(cfg, [punishment], by, `Warn \`${caseId}\` revoked`, "auto_undone")));
                }
            }
            return { case: ended, undone };
        },

        async unmute({ guildId, userId, by, reason }) {
            const note = reasonText(reason);
            await refuse(guildId, by, userId, "mute");
            const open = await repo.activeOfKind(guildId, userId, "mute");
            if (open.length === 0) throw new ModerationError("That user has no active mute.");
            await act(() => ignoring([RESTJSONErrorCodes.UnknownMember], () => discord.timeout(guildId, userId, null)));
            return endAll(await repo.getSettings(guildId), open, by, note);
        },

        async untemprole({ guildId, userId, roleId, by, reason }) {
            const note = reasonText(reason);
            await refuse(guildId, by, userId);
            const open = (await repo.activeOfKind(guildId, userId, "temprole")).filter((r) => r.role_id === roleId);
            if (open[0] === undefined) throw new ModerationError(`<@${userId}> has no temporary <@&${roleId}>.`);
            await act(() => lift(open[0] as CaseRow));
            const cfg = await repo.getSettings(guildId);
            const ended: CaseRow[] = [];
            for (const row of open) {
                const done = await finish(cfg, row, { reason: "revoked", by, note }, "revoked");
                if (done) ended.push(done);
            }
            return ended;
        },

        async unban({ guildId, userId, by, reason }) {
            const note = reasonText(reason);
            await refuse(guildId, by, userId);
            const open = await repo.activeOfKind(guildId, userId, "ban");
            let wasBanned = true;
            try {
                await act(() => discord.unban(guildId, userId));
            } catch (err) {
                if (codeOf(err) !== RESTJSONErrorCodes.UnknownBan) throw err;
                wasBanned = false;
            }
            if (!wasBanned && open.length === 0) throw new ModerationError("That user is not banned.");
            return endAll(await repo.getSettings(guildId), open, by, note);
        },

        async editReason({ guildId, caseId, reason, by }) {
            reasonText(reason);
            const row = await repo.getCase(guildId, caseId);
            const updated = row ? await repo.updateReason(caseId, reason) : null;
            if (!row || !updated) throw new ModerationError(`No case \`${caseId}\`.`);
            await repo.insertEvent({ caseId, kind: "reason_changed", byId: by, data: { from: row.reason, to: reason } });
            await post(await repo.getSettings(guildId), { event: "reason_changed", case: updated, by });
            return updated;
        },

        async expire(row) {
            const cfg = await repo.getSettings(row.guild_id);
            // Claim first: a second run finds nothing and lifts nothing twice.
            const at = deps.now();
            const ended = await repo.endCase(row.id, { reason: "expired", by: null, note: null, at });
            if (!ended) return null;
            let failure: string | null = null;
            try {
                await lift(row);
            } catch (err) {
                failure = permanentFailure(err);
                if (!failure) {
                    await repo.reopenCase(row.id); // may pass (network...): the next tick tries again
                    throw err;
                }
                logger.error(asError(err), { caseId: row.id });
            }
            const data = failure ? { note: `Couldn't lift: ${failure}` } : {};
            await repo.insertEvent({ caseId: row.id, kind: "expired", byId: null, data, at });
            await post(cfg, { event: "expired", case: ended, by: null, note: failure ? `Couldn't lift: ${failure}` : null, at });
            if (!failure && row.kind !== "temprole") {
                await sendDm(cfg, row.guild_id, row.user_id, { type: "ended", case: ended, reason: "Expired" });
            }
            return ended;
        },
    };
}
