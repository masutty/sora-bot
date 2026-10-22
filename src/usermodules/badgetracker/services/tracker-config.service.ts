import * as badges from "../repository/badges.repository";
import * as guilds from "../repository/guilds.repository";
import * as settingsRepo from "../repository/settings.repository";
import * as subscriptions from "../repository/subscriptions.repository";
import { settings } from "../settings";
import { BadgeTrackerError, type GuildBadgeRow, type RobloxBadge } from "../types";
import { parseBadgeInput } from "./badge-input";
import { createRobloxClient, type RobloxClient } from "./roblox.client";

export interface BadgePreview {
    badge: RobloxBadge;
    iconUrl: string | null;
}

export interface TrackerOverview {
    channelId: string | null;
    intervalMinutes: number;
    badges: GuildBadgeRow[];
}

export interface TrackerConfigDeps {
    roblox: RobloxClient;
    now(): Date;
    maxBadges: number;
    repo: {
        getBadge: typeof badges.getBadge;
        countBadges: typeof badges.countBadges;
        upsertBadge: typeof badges.upsertBadge;
        getGuildBadges: typeof subscriptions.getGuildBadges;
        countGuildSubscriptions: typeof subscriptions.countGuildSubscriptions;
        addSubscription: typeof subscriptions.addSubscription;
        removeSubscription: typeof subscriptions.removeSubscription;
        setPingRole: typeof subscriptions.setPingRole;
        setCustomDescription: typeof subscriptions.setCustomDescription;
        getTrackerChannel: typeof guilds.getTrackerChannel;
        setTrackerChannel: typeof guilds.setTrackerChannel;
        getTrackerSettings: typeof settingsRepo.getTrackerSettings;
        setIntervalMinutes: typeof settingsRepo.setIntervalMinutes;
    };
}

export interface TrackerConfig {
    previewBadge(guildId: string, rawInput: string): Promise<BadgePreview>;
    trackBadge(guildId: string, preview: BadgePreview, roleId: string | null): Promise<void>;
    removeBadge(guildId: string, rawInput: string): Promise<string>;
    setChannel(guildId: string, channelId: string | null): Promise<void>;
    setPingRole(guildId: string, rawInput: string, roleId: string | null): Promise<string>;
    setDescription(guildId: string, rawInput: string, text: string | null): Promise<string>;
    setIntervalMinutes(minutes: number): Promise<void>;
    getOverview(guildId: string): Promise<TrackerOverview>;
}

function parseOrThrow(rawInput: string): string {
    const id = parseBadgeInput(rawInput);
    if (id === null) throw new BadgeTrackerError("That isn't a badge ID or a roblox.com/badges link.");
    return id;
}

export function createTrackerConfig(deps: TrackerConfigDeps): TrackerConfig {
    const { repo } = deps;

    async function findSubscription(guildId: string, id: string): Promise<GuildBadgeRow | undefined> {
        return (await repo.getGuildBadges(guildId)).find((row) => row.badge_id === id);
    }

    async function requireSubscription(guildId: string, rawInput: string): Promise<GuildBadgeRow> {
        const id = parseOrThrow(rawInput);
        const row = await findSubscription(guildId, id);
        if (!row) throw new BadgeTrackerError(`This server doesn't track a badge with ID \`${id}\`.`);
        return row;
    }

    async function assertCanAdd(guildId: string, id: string): Promise<void> {
        const existing = await findSubscription(guildId, id);
        if (existing) throw new BadgeTrackerError(`This server already tracks **${existing.name}**.`);
        if ((await repo.countGuildSubscriptions(guildId)) >= settings.limits.perGuild) {
            throw new BadgeTrackerError(`This server already tracks ${settings.limits.perGuild} badges. Remove one to add another.`);
        }
    }

    return {
        async previewBadge(guildId, rawInput) {
            const id = parseOrThrow(rawInput);
            await assertCanAdd(guildId, id);
            if ((await repo.getBadge(id)) === null && (await repo.countBadges()) >= deps.maxBadges) {
                throw new BadgeTrackerError(`The bot already tracks ${deps.maxBadges} badges, its limit. Remove some to add more.`);
            }

            const result = await deps.roblox.fetchBadge(id);
            if (result.kind === "not_found") throw new BadgeTrackerError(`There's no badge with ID \`${id}\` on Roblox.`);
            if (result.kind !== "ok") throw new BadgeTrackerError("Roblox didn't answer. Try again in a minute.");

            const iconUrl = (await deps.roblox.fetchIcons([id])).get(id) ?? null;
            return { badge: result.badge, iconUrl };
        },

        async trackBadge(guildId, preview, roleId) {
            await assertCanAdd(guildId, preview.badge.id);
            await repo.upsertBadge(preview.badge, preview.iconUrl, deps.now());
            await repo.addSubscription(guildId, preview.badge.id, roleId);
        },

        async removeBadge(guildId, rawInput) {
            const row = await requireSubscription(guildId, rawInput);
            await repo.removeSubscription(guildId, row.badge_id);
            return row.name;
        },

        async setChannel(guildId, channelId) {
            await repo.setTrackerChannel(guildId, channelId);
        },

        async setPingRole(guildId, rawInput, roleId) {
            const row = await requireSubscription(guildId, rawInput);
            await repo.setPingRole(guildId, row.badge_id, roleId);
            return row.name;
        },

        async setDescription(guildId, rawInput, text) {
            const row = await requireSubscription(guildId, rawInput);
            const trimmed = text?.trim() ?? "";
            if (trimmed.length > settings.limits.descriptionMax) {
                throw new BadgeTrackerError(`Descriptions can be up to ${settings.limits.descriptionMax} characters.`);
            }
            await repo.setCustomDescription(guildId, row.badge_id, trimmed === "" ? null : trimmed);
            return row.name;
        },

        async setIntervalMinutes(minutes) {
            const { minMinutes, maxMinutes } = settings.interval;
            if (!Number.isInteger(minutes) || minutes < minMinutes || minutes > maxMinutes) {
                throw new BadgeTrackerError(`The interval must be between ${minMinutes} and ${maxMinutes} minutes.`);
            }
            await repo.setIntervalMinutes(minutes);
        },

        async getOverview(guildId) {
            const [channelId, tracker, rows] = await Promise.all([
                repo.getTrackerChannel(guildId),
                repo.getTrackerSettings(),
                repo.getGuildBadges(guildId),
            ]);
            return { channelId, intervalMinutes: tracker.interval_minutes, badges: rows };
        },
    };
}

export function defaultTrackerConfig(): TrackerConfig {
    return createTrackerConfig({
        roblox: createRobloxClient(),
        now: () => new Date(),
        maxBadges: settings.limits.global,
        repo: {
            getBadge: badges.getBadge,
            countBadges: badges.countBadges,
            upsertBadge: badges.upsertBadge,
            getGuildBadges: subscriptions.getGuildBadges,
            countGuildSubscriptions: subscriptions.countGuildSubscriptions,
            addSubscription: subscriptions.addSubscription,
            removeSubscription: subscriptions.removeSubscription,
            setPingRole: subscriptions.setPingRole,
            setCustomDescription: subscriptions.setCustomDescription,
            getTrackerChannel: guilds.getTrackerChannel,
            setTrackerChannel: guilds.setTrackerChannel,
            getTrackerSettings: settingsRepo.getTrackerSettings,
            setIntervalMinutes: settingsRepo.setIntervalMinutes,
        },
    });
}
