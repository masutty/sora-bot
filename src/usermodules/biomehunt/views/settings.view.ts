import type { Guild } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { defineView, type HandlerContext, type ViewDefinition } from "@/define";
import { parseDuration } from "@/utils/duration";

import { FLAG_DEFINITIONS } from "../constants/flags.constants";
import { getGuildFlags, setGuildFlag } from "../repository/flags.repository";
import {
    clearCounterChannel,
    clearLogChannel,
    deleteCategory,
    getEnabledCategories,
    getGuildRoles,
    getOrCreateGuildConfig,
    insertCategory,
    resetGuildConfig,
    setAutoDeleteHours,
    setGuildRoleForStatus,
    setLogChannel,
    updateAutoCreateCategories,
    updateCounterChannel,
    updateThresholds,
} from "../repository/guilds.repository";
import { getGuildUserCounts } from "../repository/users.repository";
import { forceCounterUpdate } from "../services/guild-config.service";
import { sendLogTest } from "../services/guild-log.service";
import type { ActivityStatus, FlagName, GuildRolesConfig } from "../types";
import { canBotAssignRole } from "./role-check";
import { formatHours, renderSettings, STATUSES } from "./settings.screens";

/** Defaults an empty form field falls back to - same values `resetGuildConfig` writes. */
const DEFAULT_GAP_S = 20 * 60;
const DEFAULT_IDLE_S = 30 * 60;
const DEFAULT_INACTIVE_S = 24 * 3600;

/** What the View needs that would otherwise be a DB/Discord call, injected so its tests never hit any of them. */
export interface SettingsDeps {
    updateThresholds(guildId: string, gapS: number, idleS: number, inactiveS: number): Promise<void>;
    setGuildRoleForStatus(guildId: string, status: ActivityStatus, roleId: string | null): Promise<void>;
    insertCategory(guildId: string, categoryId: string): Promise<void>;
    deleteCategory(guildId: string, categoryId: string): Promise<boolean>;
    updateAutoCreateCategories(guildId: string, enabled: boolean): Promise<void>;
    setAutoDeleteHours(guildId: string, seconds: number): Promise<void>;
    /** Only used for `AUTO_DELETE_ENABLED` and `CLEAR_PROFILE_ON_AUTODELETE`. */
    setGuildFlag(guildId: string, flag: FlagName, enabled: boolean): Promise<void>;
    updateCounterChannel(guildId: string, channelId: string): Promise<void>;
    clearCounterChannel(guildId: string): Promise<void>;
    /** Posts/edits the counter message now; resolves with the confirmation text. */
    forceCounterUpdate(guildId: string): Promise<string>;
    setLogChannel(guildId: string, channelId: string): Promise<void>;
    clearLogChannel(guildId: string): Promise<void>;
    /** Posts the test message in the log channel now; resolves with the confirmation text. */
    sendLogTest(guildId: string): Promise<string>;
    resetGuildConfig(guildId: string): Promise<void>;
    /** False when the role is managed or not below the bot's highest role. */
    canAssignRole(roleId: string): boolean;
    reload(): Promise<SettingsInput>;
    /** Member count per status, for the live counter preview. */
    counts(guildId: string): Promise<StatusCounts>;
}

export type StatusCounts = Record<ActivityStatus, number>;

export interface SettingsInput {
    guildId: string;
    gapS: number;
    idleS: number;
    inactiveS: number;
    deleteAfterS: number;
    autoCreateCategories: boolean;
    counterChannelId: string | null;
    logChannelId: string | null;
    roles: GuildRolesConfig;
    categoryIds: string[];
    autoDelete: boolean;
    clearProfileOnAutoDelete: boolean;
}

export type Screen = "home" | "roles" | "channels" | "autodelete" | "autodeleteWhat" | "counter" | "logs";

export interface SettingsState extends SettingsInput {
    screen: Screen;
    /** Member counts for the live counter preview, loaded when that screen opens. */
    counts: StatusCounts | null;
    /** Past the not-ready screen with "Show all settings". */
    showAll: boolean;
}

/** The current settings of a guild, as the View's input. */
export async function loadSettingsInput(guildId: string): Promise<SettingsInput> {
    const [config, roles, categories, flags] = await Promise.all([
        getOrCreateGuildConfig(guildId),
        getGuildRoles(guildId),
        getEnabledCategories(guildId),
        getGuildFlags(guildId),
    ]);
    return {
        guildId,
        gapS: config.session_gap_threshold_s,
        idleS: config.idle_threshold_s,
        inactiveS: config.inactive_threshold_s,
        deleteAfterS: config.delete_inactive_after_s,
        autoCreateCategories: config.auto_create_categories,
        counterChannelId: config.counter_channel_id,
        logChannelId: config.log_channel_id,
        roles,
        categoryIds: categories.map((c) => c.discord_category_id),
        autoDelete: flags.AUTO_DELETE_ENABLED,
        clearProfileOnAutoDelete: flags.CLEAR_PROFILE_ON_AUTODELETE,
    };
}

export function defaultSettingsDeps(client: BotClient, guild: Guild): SettingsDeps {
    return {
        updateThresholds,
        setGuildRoleForStatus,
        insertCategory,
        deleteCategory,
        updateAutoCreateCategories,
        setAutoDeleteHours,
        setGuildFlag,
        updateCounterChannel,
        clearCounterChannel,
        setLogChannel,
        clearLogChannel,
        sendLogTest: (guildId) => sendLogTest(client, guildId),
        forceCounterUpdate: (guildId) => forceCounterUpdate(client, guildId),
        resetGuildConfig,
        canAssignRole: (roleId) => canBotAssignRole(guild, roleId),
        reload: () => loadSettingsInput(guild.id),
        counts: getGuildUserCounts,
    };
}

type Ctx = HandlerContext<SettingsState, void>;

/** Seconds of a form field, the default when it's empty, or `undefined` when it's invalid. */
function fieldSeconds(raw: string | undefined, unit: "m" | "h", fallback: number): number | undefined {
    const text = (raw ?? "").trim();
    if (text === "") return fallback;
    return parseDuration(text, unit) ?? undefined;
}

const goTo = (screen: Screen) => (c: Ctx) => {
    c.state.screen = screen;
};

/**
 * `/admin settings`: one overview of how the server is set up, with a screen per setting. Opens
 * on just the missing macro channel category when the server isn't ready. Every change saves at once.
 */
export function settingsView(deps: SettingsDeps): ViewDefinition<SettingsState, void, SettingsInput> {
    return defineView<SettingsState, void, SettingsInput>({
        name: "biomehunt.settings",
        initial: (input) => ({ ...input, screen: "home", showAll: false, counts: null }),
        render: renderSettings,
        on: {
            showAll: (c) => {
                c.state.showAll = true;
            },
            close: (c) => c.done(),
            back: goTo("home"),
            "edit:roles": goTo("roles"),
            "edit:channels": goTo("channels"),
            "edit:autodelete": goTo("autodelete"),
            "edit:counter": async (c) => {
                c.state.counts = await deps.counts(c.state.guildId);
                c.state.screen = "counter";
            },
            "edit:logs": goTo("logs"),
            "back:autodelete": goTo("autodelete"),
            "ad:what": goTo("autodeleteWhat"),

            "edit:activity": async (c) => {
                const values = await c.modal({
                    title: "Activity times",
                    text: [
                        "Every valid macro message is part of a **session**.",
                        "- **Session gap**: a message that arrives within this time stays in the same session. If none arrives, the session ends and the next message starts a new one.",
                        "- **Idle after**: minutes without macroing, counted from the end of a session, before they show as idle.",
                        "- **Inactive after**: hours without macroing since their last session ended, before they show as inactive.",
                        "",
                        "Leave a field empty to use the default.",
                    ].join("\n"),
                    fields: [
                        {
                            key: "gap",
                            label: "Session gap, minutes (default 20)",
                            placeholder: "20",
                            value: String(Math.round(c.state.gapS / 60)),
                            required: false,
                            maxLength: 12,
                        },
                        {
                            key: "idle",
                            label: "Idle after session end, minutes (default 30)",
                            placeholder: "30",
                            value: String(Math.round(c.state.idleS / 60)),
                            required: false,
                            maxLength: 12,
                        },
                        {
                            key: "inactive",
                            label: "Inactive after session, hours (default 24)",
                            placeholder: "24",
                            value: String(Math.round(c.state.inactiveS / 3600)),
                            required: false,
                            maxLength: 12,
                        },
                    ],
                });
                if (!values) return;
                const gap = fieldSeconds(values.gap, "m", DEFAULT_GAP_S);
                const idle = fieldSeconds(values.idle, "m", DEFAULT_IDLE_S);
                const inactive = fieldSeconds(values.inactive, "h", DEFAULT_INACTIVE_S);
                if (gap === undefined || idle === undefined || inactive === undefined) {
                    const field = gap === undefined ? "Session gap" : idle === undefined ? "Idle after" : "Inactive after";
                    await c.notify(`${field} isn't a valid time. Try \`45\` or \`1h 30m\`.`);
                    return;
                }
                await deps.updateThresholds(c.state.guildId, gap, idle, inactive);
                Object.assign(c.state, { gapS: gap, idleS: idle, inactiveS: inactive });
            },

            ...Object.fromEntries(
                STATUSES.map(({ status }) => [
                    `role:${status}`,
                    async (c: Ctx) => {
                        const roleId = c.values[0] ?? null;
                        if (roleId && !deps.canAssignRole(roleId)) {
                            await c.notify("I can't give that role - it's above my highest role.");
                            return;
                        }
                        await deps.setGuildRoleForStatus(c.state.guildId, status, roleId);
                        c.state.roles = { ...c.state.roles, [status]: roleId };
                    },
                ]),
            ),

            categories: async (c) => {
                const { guildId, categoryIds } = c.state;
                const next = c.values;
                for (const id of next.filter((v) => !categoryIds.includes(v))) await deps.insertCategory(guildId, id);
                for (const id of categoryIds.filter((v) => !next.includes(v))) await deps.deleteCategory(guildId, id);
                c.state.categoryIds = [...next];
            },
            autocreate: async (c) => {
                const enabled = !c.state.autoCreateCategories;
                await deps.updateAutoCreateCategories(c.state.guildId, enabled);
                c.state.autoCreateCategories = enabled;
            },

            "ad:toggle": async (c) => {
                const enabled = !c.state.autoDelete;
                await deps.setGuildFlag(c.state.guildId, "AUTO_DELETE_ENABLED", enabled);
                c.state.autoDelete = enabled;
            },
            "ad:after": async (c) => {
                const values = await c.modal({
                    title: "Auto-delete after",
                    fields: [
                        {
                            key: "after",
                            label: "Hours inactive",
                            placeholder: formatHours(c.state.deleteAfterS),
                            required: true,
                            maxLength: 12,
                        },
                    ],
                });
                if (!values) return;
                const seconds = parseDuration(values.after ?? "", "h");
                if (seconds === null) {
                    await c.notify("That isn't a valid time. Try `72` or `3d`.");
                    return;
                }
                await deps.setAutoDeleteHours(c.state.guildId, seconds);
                c.state.deleteAfterS = seconds;
            },
            "what:unlink": async (c) => {
                await deps.setGuildFlag(c.state.guildId, "CLEAR_PROFILE_ON_AUTODELETE", false);
                Object.assign(c.state, { clearProfileOnAutoDelete: false, screen: "autodelete" });
            },
            "what:wipe": async (c) => {
                await deps.setGuildFlag(c.state.guildId, "CLEAR_PROFILE_ON_AUTODELETE", true);
                Object.assign(c.state, { clearProfileOnAutoDelete: true, screen: "autodelete" });
            },

            counter: async (c) => {
                const channelId = c.values[0];
                if (channelId) await deps.updateCounterChannel(c.state.guildId, channelId);
                else await deps.clearCounterChannel(c.state.guildId);
                c.state.counterChannelId = channelId ?? null;
            },
            refresh: async (c) => {
                if (!c.state.counterChannelId) {
                    await c.notify("Pick a channel first.");
                    return;
                }
                await c.notify(await deps.forceCounterUpdate(c.state.guildId));
                c.state.counts = await deps.counts(c.state.guildId);
            },

            logs: async (c) => {
                const channelId = c.values[0];
                if (channelId) await deps.setLogChannel(c.state.guildId, channelId);
                else await deps.clearLogChannel(c.state.guildId);
                c.state.logChannelId = channelId ?? null;
            },
            "logs:test": async (c) => {
                if (!c.state.logChannelId) {
                    await c.notify("Pick a channel first.");
                    return;
                }
                await c.notify(await deps.sendLogTest(c.state.guildId));
            },

            reset: async (c) => {
                const values = await c.modal({
                    title: "Reset all settings",
                    text: "Activity times, status roles, macro channel categories, auto-delete and the live counter and the log channel go back to their defaults. Members, channels and forwards stay.",
                    fields: [{ key: "confirm", label: "Type reset to confirm", placeholder: "reset", required: true, maxLength: 10 }],
                });
                if (!values) return;
                if ((values.confirm ?? "").trim().toLowerCase() !== "reset") {
                    await c.notify("Nothing was reset. Type `reset` to confirm.");
                    return;
                }
                await deps.resetGuildConfig(c.state.guildId);
                for (const flag of ["AUTO_DELETE_ENABLED", "CLEAR_PROFILE_ON_AUTODELETE"] as const) {
                    await deps.setGuildFlag(c.state.guildId, flag, FLAG_DEFINITIONS[flag].default);
                }
                Object.assign(c.state, await deps.reload(), { screen: "home", showAll: false, counts: null });
            },
        },
    });
}
