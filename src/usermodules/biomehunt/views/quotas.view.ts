import { ButtonStyle, type Guild } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { confirm, defineView, type HandlerContext, paginationHandlers, type ViewDefinition } from "@/define";
import { parseDuration } from "@/utils/duration";
import { EmbedFormatter, formatTime } from "@/utils/format";

import { QUOTA_PRESETS } from "../constants/quota-presets.constants";
import { getOrCreateGuildConfig, updateQuotaEvalHour } from "../repository/guilds.repository";
import { countQuotaRoleHolders, deleteQuotaRole, getQuotaRolesForGuild, upsertQuotaRole } from "../repository/quota-roles.repository";
import { forceQuotaEval, hitCount, loadQuotaDayReport } from "../services/quota.service";
import type { QuotaRoleMode, QuotaRoleRow } from "../types";
import { type QuotaStatsInput, quotaStatsView } from "./quota-report.view";
import { QUOTAS_PER_PAGE, quotaPages, renderQuotas } from "./quotas.screens";
import { canBotAssignRole } from "./role-check";

const DAILY_WINDOW_HOURS = 24;
const DEFAULT_WEEK_HOURS = 168;
const RED = 0xda373c;
const ORANGE = 0xf0b232;

/** What the View needs that would otherwise be a DB/Discord call, injected so its tests never hit any of them. */
export interface QuotasDeps {
    upsertQuotaRole(
        guildId: string,
        roleId: string,
        mode: QuotaRoleMode,
        targetS: number,
        windowH: number,
        days: number | null,
    ): Promise<QuotaRoleRow>;
    deleteQuotaRole(guildId: string, roleId: string): Promise<boolean>;
    updateQuotaEvalHour(guildId: string, hourUtc: number): Promise<void>;
    /** Runs the daily check now; resolves with the confirmation text. */
    forceQuotaEval(guildId: string): Promise<string>;
    countHolders(roleId: string): Promise<number>;
    countHitToday(roleId: string): Promise<number>;
    /** False when the role is managed or not below the bot's highest role. */
    canAssignRole(roleId: string): boolean;
    /** The role's name and color (null when it has none), for the form title and the editor accent. */
    roleInfo(roleId: string): { name: string; color: number | null };
    /** Everything "Who hit it" needs for the quota day reports. */
    loadStats(): Promise<QuotaStatsInput>;
}

export interface QuotasInput {
    guildId: string;
    quotas: QuotaRoleRow[];
    /** Quota role id -> members who have it. */
    holders: Record<string, number>;
    evalHourUtc: number;
}

export type QuotasScreen = "list" | "editor" | "addRole" | "addPreset" | "addType";

export interface QuotasState extends QuotasInput {
    screen: QuotasScreen;
    page: number;
    /** The quota being edited, or the role being added. */
    roleId: string | null;
    /** Whether the type screen is for a new quota or for changing an existing one. */
    typeFor: "add" | "change";
    color: number | null;
    hitToday: number;
}

/** The quotas of a guild with their holder counts, as the View's input. */
export async function loadQuotasInput(guildId: string): Promise<QuotasInput> {
    const [quotas, config] = await Promise.all([getQuotaRolesForGuild(guildId), getOrCreateGuildConfig(guildId)]);
    const counts = await Promise.all(quotas.map((q) => countQuotaRoleHolders(guildId, q.role_id)));
    return {
        guildId,
        quotas,
        holders: Object.fromEntries(quotas.map((q, i) => [q.role_id, counts[i]])),
        evalHourUtc: config.quota_eval_hour_utc,
    };
}

export function defaultQuotasDeps(client: BotClient, guild: Guild): QuotasDeps {
    const loadReports = async () => {
        const members = await guild.members.fetch();
        const isInGuild = (id: string) => members.has(id);
        const now = new Date();
        const [today, yesterday] = await Promise.all([
            loadQuotaDayReport(guild.id, 0, isInGuild, now),
            loadQuotaDayReport(guild.id, 1, isInGuild, now),
        ]);
        return { today, yesterday };
    };
    return {
        upsertQuotaRole,
        deleteQuotaRole,
        updateQuotaEvalHour,
        forceQuotaEval: (guildId) => forceQuotaEval(client, guildId),
        countHolders: (roleId) => countQuotaRoleHolders(guild.id, roleId),
        countHitToday: async (roleId) => {
            const { today } = await loadReports();
            const role = today.roles.find((r) => r.role_id === roleId);
            return role ? hitCount(today.members, role.quota_target_seconds) : 0;
        },
        canAssignRole: (roleId) => canBotAssignRole(guild, roleId),
        roleInfo: (roleId) => {
            const role = guild.roles.cache.get(roleId);
            return { name: role?.name ?? `Role ${roleId}`, color: role?.color ? role.color : null };
        },
        loadStats: async () => {
            const reports = await loadReports();
            const roleNames = Object.fromEntries(
                reports.today.roles.map((r) => [r.role_id, guild.roles.cache.get(r.role_id)?.name ?? `Role ${r.role_id}`]),
            );
            return { reports, roleNames };
        },
    };
}

type Ctx = HandlerContext<QuotasState, void>;

const quotaOf = (s: QuotasState, roleId: string | null) => s.quotas.find((q) => q.role_id === roleId);

/** What happens to the members who already have the role when its quota is deleted. */
function deleteNote(mode: QuotaRoleMode, holders: number): string {
    const who = `The ${holders} ${holders === 1 ? "member who has it" : "members who have it"}`;
    return mode === "F"
        ? `${who} ${holders === 1 ? "keeps" : "keep"} it until it runs out.`
        : `${who} ${holders === 1 ? "keeps" : "keep"} the role until an admin removes it.`;
}

/**
 * `/bh-admin quotas`: the server's quotas as a list, an editor per quota, and the daily check time.
 * Every change saves at once. Stored modes stay `F` / `RW`; the UI says Daily reward / Live role.
 */
export function quotasView(deps: QuotasDeps): ViewDefinition<QuotasState, void, QuotasInput> {
    /** Opens the editor on a quota already in `state.quotas`. */
    async function showEditor(s: QuotasState, roleId: string): Promise<void> {
        const q = quotaOf(s, roleId);
        s.roleId = roleId;
        s.color = deps.roleInfo(roleId).color;
        s.hitToday = q?.mode === "F" ? await deps.countHitToday(roleId) : 0;
        s.screen = "editor";
    }

    /** Saves a quota, puts it in the state and opens its editor. */
    async function save(
        s: QuotasState,
        roleId: string,
        mode: QuotaRoleMode,
        targetS: number,
        windowH: number,
        days: number | null,
    ): Promise<void> {
        const row = await deps.upsertQuotaRole(s.guildId, roleId, mode, targetS, windowH, days);
        s.quotas = s.quotas.some((q) => q.role_id === roleId) ? s.quotas.map((q) => (q.role_id === roleId ? row : q)) : [...s.quotas, row];
        s.holders = { ...s.holders, [roleId]: await deps.countHolders(roleId) };
        await showEditor(s, roleId);
    }

    /** The numbers form for a type, prefilled from the quota when it already has that type. Saves on submit. */
    async function numbersForm(c: Ctx, mode: QuotaRoleMode): Promise<void> {
        const { roleId } = c.state;
        if (!roleId) return;
        const current = quotaOf(c.state, roleId);
        const same = current?.mode === mode ? current : undefined;
        const daily = mode === "F";
        const fields = [
            {
                key: "target",
                label: "Macro time needed (e.g. 6h or 1h30m)",
                value: formatTime(current?.quota_target_seconds ?? 5 * 3600),
                required: true,
                maxLength: 12,
            },
            daily
                ? { key: "extra", label: "Role lasts (days)", value: String(same?.access_duration_days ?? 1), required: true, maxLength: 4 }
                : {
                      key: "extra",
                      label: "Counted over (e.g. 7d or 48h)",
                      value: formatTime((same?.quota_window_hours ?? DEFAULT_WEEK_HOURS) * 3600),
                      required: true,
                      maxLength: 12,
                  },
        ];
        const values = await c.modal({ title: `Edit ${deps.roleInfo(roleId).name}`.slice(0, 45), fields });
        if (!values) return;

        const targetS = parseDuration(values.target ?? "", "h");
        if (targetS === null) {
            await c.notify("Macro time needed isn't valid. Try `6h` or `1h 30m`.");
            return;
        }
        if (daily) {
            const raw = (values.extra ?? "").trim();
            const days = /^\d+$/.test(raw) ? Number(raw) : 0;
            if (days < 1) {
                await c.notify("Role lasts needs a whole number of days, like `3`.");
                return;
            }
            await save(c.state, roleId, "F", targetS, DAILY_WINDOW_HOURS, days);
            return;
        }
        const overS = parseDuration(values.extra ?? "", "h");
        if (overS === null || overS % 3600 !== 0) {
            await c.notify("Counted over needs whole hours. Try `7d` or `48h`.");
            return;
        }
        await save(c.state, roleId, "RW", targetS, overS / 3600, null);
    }

    const editQuota = (slot: number) => async (c: Ctx) => {
        const q = c.state.quotas[c.state.page * QUOTAS_PER_PAGE + slot];
        if (q) await showEditor(c.state, q.role_id);
    };

    return defineView<QuotasState, void, QuotasInput>({
        name: "biomehunt.quotas",
        initial: (input) => ({ ...input, screen: "list", page: 0, roleId: null, typeFor: "add", color: null, hitToday: 0 }),
        render: renderQuotas,
        on: {
            ...paginationHandlers<QuotasState>({ pages: (s) => quotaPages(s.quotas) }),
            ...Object.fromEntries(Array.from({ length: QUOTAS_PER_PAGE }, (_, slot) => [`edit:${slot}`, editQuota(slot)])),

            back: (c) => {
                const { state } = c;
                state.screen = state.screen === "addType" && state.typeFor === "change" ? "editor" : "list";
            },

            add: (c) => {
                c.state.screen = "addRole";
            },
            addRole: async (c) => {
                const roleId = c.values[0];
                if (!roleId) return;
                if (quotaOf(c.state, roleId)) {
                    await showEditor(c.state, roleId);
                    return;
                }
                if (!deps.canAssignRole(roleId)) {
                    await c.notify("I can't give that role - it's above my highest role.");
                    return;
                }
                c.state.roleId = roleId;
                c.state.screen = "addPreset";
            },
            preset: async (c) => {
                const { roleId } = c.state;
                const key = c.values[0];
                if (!roleId) return;
                if (key === "custom") {
                    c.state.typeFor = "add";
                    c.state.screen = "addType";
                    return;
                }
                const preset = QUOTA_PRESETS.find((p) => p.key === key);
                if (preset) await save(c.state, roleId, preset.mode, preset.targetS, preset.windowH, preset.days);
            },
            "type:F": (c) => numbersForm(c, "F"),
            "type:RW": (c) => numbersForm(c, "RW"),

            editNumbers: (c) => {
                const q = quotaOf(c.state, c.state.roleId);
                return q ? numbersForm(c, q.mode) : undefined;
            },
            changeType: (c) => {
                c.state.typeFor = "change";
                c.state.screen = "addType";
            },
            whoHit: async (c) => {
                const input = await deps.loadStats();
                await c.open(quotaStatsView, { ...input, roleId: c.state.roleId ?? undefined });
            },

            delete: async (c) => {
                const { guildId, roleId } = c.state;
                const q = quotaOf(c.state, roleId);
                if (!roleId || !q) return;
                const holders = c.state.holders[roleId] ?? 0;
                const deleted = await c.open(
                    confirm({
                        name: "biomehunt.quotas-delete",
                        title: `Delete the <@&${roleId}> quota?`,
                        body: `-# ${deleteNote(q.mode, holders)}`,
                        color: RED,
                        confirmLabel: "Delete",
                        confirmStyle: ButtonStyle.Danger,
                        cancelStyle: ButtonStyle.Secondary,
                        onConfirm: async () => {
                            await deps.deleteQuotaRole(guildId, roleId);
                            return EmbedFormatter.success("Deleted.");
                        },
                    }),
                    undefined,
                );
                if (!deleted) return;
                c.state.quotas = c.state.quotas.filter((x) => x.role_id !== roleId);
                c.state.page = Math.min(c.state.page, quotaPages(c.state.quotas) - 1);
                c.state.screen = "list";
            },

            checkTime: async (c) => {
                const values = await c.modal({
                    title: "Daily check time",
                    text: "All daily rewards are checked at this hour. Their day runs from this hour to the same hour the next day.",
                    fields: [
                        {
                            key: "hour",
                            label: "Hour in UTC (0-23)",
                            value: String(c.state.evalHourUtc),
                            required: true,
                            maxLength: 2,
                        },
                    ],
                });
                if (!values) return;
                const raw = (values.hour ?? "").trim();
                const hour = /^\d{1,2}$/.test(raw) ? Number(raw) : -1;
                if (hour < 0 || hour > 23) {
                    await c.notify("The hour must be a number from 0 to 23.");
                    return;
                }
                await deps.updateQuotaEvalHour(c.state.guildId, hour);
                c.state.evalHourUtc = hour;
            },
            checkNow: async (c) => {
                if (!c.state.quotas.some((q) => q.mode === "F")) {
                    await c.notify("No daily rewards to check.");
                    return;
                }
                let result = "";
                const ran = await c.open(
                    confirm({
                        name: "biomehunt.quotas-check-now",
                        title: "Check daily rewards now?",
                        body: "This gives or renews daily reward roles right away.",
                        color: ORANGE,
                        confirmLabel: "Check now",
                        cancelStyle: ButtonStyle.Secondary,
                        onConfirm: async () => {
                            result = await deps.forceQuotaEval(c.state.guildId);
                            return EmbedFormatter.success(result);
                        },
                    }),
                    undefined,
                );
                if (!ran) return;
                await c.notify(result);
                // The check grants and renews roles, so the counts shown are stale.
                const counts = await Promise.all(c.state.quotas.map((q) => deps.countHolders(q.role_id)));
                c.state.holders = Object.fromEntries(c.state.quotas.map((q, i) => [q.role_id, counts[i]]));
            },
        },
    });
}
