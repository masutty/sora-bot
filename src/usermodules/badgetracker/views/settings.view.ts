import { ButtonStyle, type Guild } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { confirm, defineView, type HandlerContext, paginationHandlers, type ViewDefinition } from "@/define";
import { EmbedFormatter } from "@/utils/format";
import { formatHexColor } from "../services/color";
import { canMention, type PostStatus, postStatus } from "../services/post-status";
import { type BadgePreview, defaultTrackerConfig, type TrackerConfig, type TrackerOverview } from "../services/tracker-config.service";
import { settings } from "../settings";
import { BadgeTrackerError } from "../types";
import { AWARD_COLOR } from "./award-post";
import { badgePages, cut, renderTrackerSettings } from "./settings.screens";

export { renderOverviewReadOnly, renderTrackerSettings } from "./settings.screens";

const RED = 0xda373c;

export type TrackerScreen = "overview" | "preview" | "editor";

export interface TrackerViewState {
    screen: TrackerScreen;
    /** 0-based page of the badge list. */
    page: number;
    overview: TrackerOverview;
    /** Whether the bot can post in the Tracking Channel, for the overview's warning. */
    status: PostStatus;
    preview: BadgePreview | null;
    previewRoleId: string | null;
    /** The badge in the editor. */
    badgeId: string | null;
}

/** What the View needs that would otherwise be a DB/Discord call, injected so its tests never hit any of them. */
export interface TrackerViewDeps {
    guildId: string;
    config: TrackerConfig;
    postStatus(channelId: string | null): PostStatus;
    canMention(roleId: string): boolean;
}

export function defaultTrackerViewDeps(client: BotClient, guild: Guild): TrackerViewDeps {
    return {
        guildId: guild.id,
        config: defaultTrackerConfig(),
        postStatus: (channelId) => postStatus(client, guild.id, channelId),
        canMention: (roleId) => canMention(guild, roleId),
    };
}

type Ctx = HandlerContext<TrackerViewState, void>;

const MODAL_TITLE_MAX = 45;

/** `/badgetracker settings`: the Tracking Channel, the check interval and this server's badges. */
export function trackerSettingsView(deps: TrackerViewDeps): ViewDefinition<TrackerViewState, void, void> {
    const { config, guildId } = deps;

    /** Re-reads the overview so the screen reflects the DB. */
    async function reload(s: TrackerViewState): Promise<void> {
        s.overview = await config.getOverview(guildId);
        s.status = deps.postStatus(s.overview.channelId);
        s.page = Math.min(s.page, badgePages(s.overview) - 1);
    }

    /** Runs a mutation; a BadgeTrackerError is told to the user and leaves the state as it was. */
    async function attempt(c: Ctx, action: () => Promise<void>): Promise<boolean> {
        try {
            await action();
            return true;
        } catch (err) {
            if (!(err instanceof BadgeTrackerError)) throw err;
            await c.notify(err.message);
            return false;
        }
    }

    const currentBadge = (s: TrackerViewState) => s.overview.badges.find((b) => b.badge_id === s.badgeId);

    /** Resolves a role select's pick; `undefined` when the bot can't ping it (already told to the user). */
    async function pickRole(c: Ctx): Promise<string | null | undefined> {
        const roleId = c.values[0] ?? null;
        if (roleId && !deps.canMention(roleId)) {
            await c.notify(`I can't ping <@&${roleId}>. Make it mentionable or give me the Mention Everyone permission.`);
            return undefined;
        }
        return roleId;
    }

    const changeInterval = async (c: Ctx) => {
        const values = await c.modal({
            title: "Check interval",
            text: "How often every tracked badge is checked. This applies to all servers.",
            fields: [
                { key: "minutes", label: "Minutes (1-60)", required: true, maxLength: 2, value: String(c.state.overview.intervalMinutes) },
            ],
        });
        if (!values) return;
        const saved = await attempt(c, () => config.setIntervalMinutes(Number(values.minutes.trim())));
        if (saved) await reload(c.state);
    };

    const addBadge = async (c: Ctx) => {
        const values = await c.modal({
            title: "Track a badge",
            fields: [
                {
                    key: "badge",
                    label: "Badge ID or link",
                    required: true,
                    placeholder: "2124445684 or https://www.roblox.com/badges/…",
                },
            ],
        });
        if (!values) return;
        let found: BadgePreview | undefined;
        await attempt(c, async () => {
            found = await config.previewBadge(guildId, values.badge);
        });
        if (found) Object.assign(c.state, { preview: found, previewRoleId: null, screen: "preview" });
    };

    const track = async (c: Ctx) => {
        const { preview, previewRoleId } = c.state;
        if (!preview) return;
        const saved = await attempt(c, () => config.trackBadge(guildId, preview, previewRoleId));
        if (!saved) return;
        await reload(c.state);
        Object.assign(c.state, { preview: null, previewRoleId: null, screen: "overview" });
    };

    const editDescription = async (c: Ctx) => {
        const badge = currentBadge(c.state);
        if (!badge) return;
        const robloxText = badge.description.trim();
        const values = await c.modal({
            title: cut(`Description for ${badge.name}`, MODAL_TITLE_MAX),
            ...(robloxText ? { text: `Roblox's description: *${cut(robloxText, settings.limits.descriptionMax)}*` } : {}),
            fields: [
                {
                    key: "description",
                    label: "Description (empty = Roblox's)",
                    style: "paragraph",
                    required: false,
                    maxLength: settings.limits.descriptionMax,
                    value: (badge.custom_description ?? badge.description).slice(0, settings.limits.descriptionMax),
                },
            ],
        });
        if (!values) return;
        const text = values.description.trim();
        // Submitting Roblox's own text unchanged is not a custom description.
        const custom = text === "" || (!badge.custom_description && text === robloxText) ? null : values.description;
        const saved = await attempt(c, async () => {
            await config.setDescription(guildId, badge.badge_id, custom);
        });
        if (saved) await reload(c.state);
    };

    const editColor = async (c: Ctx) => {
        const badge = currentBadge(c.state);
        if (!badge) return;
        const values = await c.modal({
            title: cut(`Color for ${badge.name}`, MODAL_TITLE_MAX),
            fields: [
                {
                    key: "color",
                    label: "Hex color (empty = default)",
                    required: false,
                    maxLength: 7,
                    placeholder: formatHexColor(AWARD_COLOR),
                    value: badge.accent_color === null ? "" : formatHexColor(badge.accent_color),
                },
            ],
        });
        if (!values) return;
        const saved = await attempt(c, async () => {
            await config.setColor(guildId, badge.badge_id, values.color);
        });
        if (saved) await reload(c.state);
    };

    const remove = async (c: Ctx) => {
        const badge = currentBadge(c.state);
        if (!badge) return;
        const removed = await c.open(
            confirm({
                name: "badge-tracker.remove",
                title: "Stop tracking this badge?",
                body: badge.name,
                color: RED,
                confirmLabel: "Remove",
                confirmStyle: ButtonStyle.Danger,
                cancelStyle: ButtonStyle.Secondary,
                onConfirm: async () => {
                    const name = await config.removeBadge(guildId, badge.badge_id);
                    return EmbedFormatter.success(`${name} is no longer tracked.`);
                },
            }),
            undefined,
        );
        if (!removed) return;
        await reload(c.state);
        Object.assign(c.state, { badgeId: null, screen: "overview" });
    };

    return defineView<TrackerViewState, void, void>({
        name: "badge-tracker.settings",
        initial: async () => {
            const overview = await config.getOverview(guildId);
            return {
                screen: "overview",
                page: 0,
                overview,
                status: deps.postStatus(overview.channelId),
                preview: null,
                previewRoleId: null,
                badgeId: null,
            };
        },
        render: renderTrackerSettings,
        on: {
            ...paginationHandlers<TrackerViewState>({ pages: (s) => badgePages(s.overview) }),
            ...Object.fromEntries(
                Array.from({ length: settings.ui.badgesPerPage }, (_, slot) => [
                    `edit:${slot}`,
                    (c: Ctx) => {
                        const badge = c.state.overview.badges[c.state.page * settings.ui.badgesPerPage + slot];
                        if (badge) Object.assign(c.state, { badgeId: badge.badge_id, screen: "editor" });
                    },
                ]),
            ),

            channel: async (c) => {
                const saved = await attempt(c, () => config.setChannel(guildId, c.values[0] ?? null));
                if (saved) await reload(c.state);
            },
            interval: changeInterval,
            add: addBadge,
            previewRole: async (c) => {
                const roleId = await pickRole(c);
                if (roleId !== undefined) c.state.previewRoleId = roleId;
            },
            track,
            cancel: (c) => {
                Object.assign(c.state, { preview: null, previewRoleId: null, screen: "overview" });
            },
            editRole: async (c) => {
                const badge = currentBadge(c.state);
                const roleId = await pickRole(c);
                if (!badge || roleId === undefined) return;
                const saved = await attempt(c, async () => {
                    await config.setPingRole(guildId, badge.badge_id, roleId);
                });
                if (saved) await reload(c.state);
            },
            editDescription,
            editColor,
            remove,
            back: (c) => {
                Object.assign(c.state, { badgeId: null, screen: "overview" });
            },
        },
    });
}
