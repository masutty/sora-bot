import { ButtonStyle } from "discord.js";
import { confirm, defineView, type HandlerContext, paginationHandlers, type ViewDefinition } from "@/define";
import { EmbedFormatter, formatTime } from "@/utils/format";
import { EXAMPLE_LADDER, thresholdLabel } from "../services/ladder";
import { parseThreshold, withThreshold } from "../services/threshold-input";
import { settings } from "../settings";
import { ModerationError, type ModSettings, type Threshold } from "../types";
import { renderSettings, THRESHOLDS_PER_PAGE, thresholdPageCount } from "./settings.screens";

export interface SettingsState {
    screen: "main" | "ladder" | "role" | "channel";
    settings: ModSettings;
    ladder: Threshold[];
    /** Page of the Thresholds screen (0-based). */
    page: number;
}

/** The repository calls the panel needs, injected so its tests never hit the database. */
export interface SettingsDeps {
    guildId: string;
    getSettings(guildId: string): Promise<ModSettings>;
    updateSettings(guildId: string, patch: Partial<Omit<ModSettings, "guild_id">>): Promise<ModSettings>;
    getThresholds(guildId: string): Promise<Threshold[]>;
    replaceThresholds(guildId: string, ladder: Threshold[]): Promise<void>;
}

type Ctx = HandlerContext<SettingsState, void>;

const GREEN = 0x248046;

/** `moderator settings`: moderator role, Case Channel, warn expiry, Auto-Punishment and its Thresholds, auto-undo, Appeal line. */
export function settingsView(deps: SettingsDeps): ViewDefinition<SettingsState, void, void> {
    const { guildId } = deps;

    const patch = async (c: Ctx, change: Partial<Omit<ModSettings, "guild_id">>) => {
        c.state.settings = await deps.updateSettings(guildId, change);
    };

    const saveLadder = async (c: Ctx, ladder: Threshold[]) => {
        await deps.replaceThresholds(guildId, ladder);
        c.state.ladder = ladder;
        c.state.page = Math.min(c.state.page, thresholdPageCount(ladder.length) - 1);
    };

    /** Turn an On/Off setting on or off after a confirm on the same message. */
    const toggle = (field: "auto_enabled" | "auto_undo", label: string) => async (c: Ctx) => {
        const enable = !c.state.settings[field];
        let saved: ModSettings | undefined;
        const done = await c.open(
            confirm({
                name: "moderation.toggle",
                title: `${enable ? "Turn on" : "Turn off"} ${label}?`,
                color: enable ? GREEN : settings.punishColor,
                confirmLabel: enable ? "Turn on" : "Turn off",
                confirmStyle: enable ? ButtonStyle.Success : ButtonStyle.Danger,
                cancelLabel: "Cancel",
                cancelStyle: ButtonStyle.Secondary,
                onConfirm: async () => {
                    saved = await deps.updateSettings(guildId, { [field]: enable });
                    return EmbedFormatter.success("Saved.");
                },
            }),
            undefined,
        );
        if (done && saved) c.state.settings = saved;
    };

    /**
     * Add (`existing` null) or edit a Threshold; a refused value is told to the user and nothing changes.
     * An edit with the warns count emptied removes the Threshold.
     */
    async function thresholdModal(c: Ctx, existing: Threshold | null) {
        const values = await c.modal({
            title: existing ? "Edit Threshold" : "Add Threshold",
            fields: [
                {
                    key: "warns",
                    label: existing ? "Active warns (empty removes)" : "Active warns",
                    required: !existing,
                    maxLength: 3,
                    value: existing ? String(existing.warns) : undefined,
                },
                {
                    key: "action",
                    label: "Action",
                    placeholder: "none, mute, kick or ban",
                    required: false,
                    maxLength: 4,
                    value: existing?.action ?? undefined,
                },
                {
                    key: "duration",
                    label: "Duration (mute, ban)",
                    placeholder: "12h, 7d",
                    required: false,
                    maxLength: 20,
                    value: existing?.durationS ? formatTime(existing.durationS) : undefined,
                },
            ],
        });
        if (!values) return;
        if (existing && (values.warns ?? "").trim() === "") {
            await saveLadder(
                c,
                c.state.ladder.filter((t) => t.warns !== existing.warns),
            );
            return;
        }
        try {
            const next = parseThreshold({ warns: values.warns ?? "", action: values.action ?? "", duration: values.duration ?? "" });
            await saveLadder(c, withThreshold(c.state.ladder, next, existing?.warns ?? null));
        } catch (err) {
            if (!(err instanceof ModerationError)) throw err;
            await c.notify(err.message);
        }
    }

    const edit = (slot: number) => (c: Ctx) => {
        const existing = c.state.ladder[c.state.page * THRESHOLDS_PER_PAGE + slot];
        return existing ? thresholdModal(c, existing) : undefined;
    };

    return defineView<SettingsState, void, void>({
        name: "moderation.settings",
        access: "invoker",
        initial: async () => ({
            screen: "main",
            settings: await deps.getSettings(guildId),
            ladder: await deps.getThresholds(guildId),
            page: 0,
        }),
        render: renderSettings,
        on: {
            ...paginationHandlers<SettingsState>({ pages: (s) => thresholdPageCount(s.ladder.length) }),
            ...Object.fromEntries(Array.from({ length: THRESHOLDS_PER_PAGE }, (_, i) => [`edit:${i}`, edit(i)])),
            pickRole: (c) => {
                c.state.screen = "role";
            },
            pickChannel: (c) => {
                c.state.screen = "channel";
            },
            role: async (c) => {
                await patch(c, { moderator_role_id: c.values[0] ?? null });
                c.state.screen = "main";
            },
            channel: async (c) => {
                await patch(c, { case_channel_id: c.values[0] ?? null });
                c.state.screen = "main";
            },
            auto: toggle("auto_enabled", "Auto-Punishment"),
            undo: toggle("auto_undo", "Auto-undo"),
            expiry: async (c) => {
                const { min, max } = settings.warnExpiryDaysRange;
                const values = await c.modal({
                    title: "Warn expiry",
                    fields: [
                        {
                            key: "days",
                            label: `Days (${min}-${max})`,
                            required: true,
                            maxLength: 3,
                            value: String(c.state.settings.warn_expiry_days),
                        },
                    ],
                });
                if (!values) return;
                const days = Number((values.days ?? "").trim());
                if (!Number.isInteger(days) || days < min || days > max) {
                    await c.notify(`Enter a whole number from ${min} to ${max}.`);
                    return;
                }
                await patch(c, { warn_expiry_days: days });
            },
            appeal: async (c) => {
                const values = await c.modal({
                    title: "Appeal line",
                    fields: [
                        {
                            key: "line",
                            label: "Shown in DMs (empty clears)",
                            style: "paragraph",
                            required: false,
                            maxLength: settings.maxAppealLine,
                            value: c.state.settings.appeal_line ?? undefined,
                        },
                    ],
                });
                if (!values) return;
                await patch(c, { appeal_line: (values.line ?? "").trim() || null });
            },
            ladder: (c) => {
                Object.assign(c.state, { screen: "ladder", page: 0 });
            },
            back: (c) => {
                Object.assign(c.state, { screen: "main", page: 0 });
            },
            add: (c) => thresholdModal(c, null),
            example: async (c) => {
                const replaced = await c.open(
                    confirm({
                        name: "moderation.example",
                        title: "Replace the Thresholds with the example?",
                        body: EXAMPLE_LADDER.map(thresholdLabel).join("\n"),
                        color: settings.punishColor,
                        confirmLabel: "Replace",
                        confirmStyle: ButtonStyle.Danger,
                        cancelStyle: ButtonStyle.Secondary,
                        onConfirm: async () => {
                            await deps.replaceThresholds(guildId, EXAMPLE_LADDER);
                            return EmbedFormatter.success("Thresholds replaced.");
                        },
                    }),
                    undefined,
                );
                if (replaced) Object.assign(c.state, { ladder: EXAMPLE_LADDER, page: 0 });
            },
        },
    });
}
