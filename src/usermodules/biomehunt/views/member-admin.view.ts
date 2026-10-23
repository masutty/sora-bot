import { ButtonStyle, ContainerBuilder, type Guild, type GuildMember, MessageFlags } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { describeCommandError } from "@/core/command/user-facing-error";
import { confirm, defineView, type HandlerContext, paginationHandlers, type ViewDefinition } from "@/define";
import { EmbedFormatter, formatTime, NO_PINGS } from "@/utils/format";
import { getBadgeMeta } from "../constants/badges.constants";
import { formatBiomeName } from "../constants/biomes.constants";
import { countSessionsForUser, deleteAllSessionsForUser, getBiomeCountForUser, getBiomeCounts } from "../repository/activity.repository";
import { getGuildBadgeRoles, getUserBadges } from "../repository/badges.repository";
import { isFlagEnabled } from "../repository/flags.repository";
import { getOrCreateGuildConfig } from "../repository/guilds.repository";
import { getMacroChannelByUserId, getUserByDiscordId } from "../repository/users.repository";
import { awardBadge, takeBadge } from "../services/badge.service";
import { grantEconomy } from "../services/economy.service";
import {
    deleteMemberEverything,
    deleteSessions,
    forceSetupMember,
    pauseMember,
    type ResetTotals,
    resetMemberProgress,
    setBiomeCount,
    unlinkMember,
    unpauseMember,
} from "../services/member.service";
import { BiomeHuntError } from "../types";
import {
    badgeOnPage,
    badgePages,
    biomeCount,
    editableBiomes,
    MEMBER_TABS,
    plural,
    renderMemberAdmin,
    sessionPages,
    sessionsOnPage,
} from "./member-admin.screens";
import { loadProfileData } from "./profile.view";
import { canBotAssignRole } from "./role-check";
import { loadSessionInput, sessionView } from "./session.view";
import type { ProfileData } from "./stats-builders";

const RED = 0xda373c;

export interface MemberChannelInfo {
    channelId: string;
    createdAt: Date;
    webhookWorking: boolean;
}

/** Everything the panel shows, read from the database. */
export interface MemberAdminSnapshot {
    /** `null` = the member has no profile. */
    data: ProfileData | null;
    channel: MemberChannelInfo | null;
    /** The `AUTO_DELETE_ENABLED` flag. */
    autoDelete: boolean;
    deleteAfterS: number;
    /** How many sessions the member has in all. */
    sessionTotal: number;
    /** Badge -> the role it gives. */
    badgeRoles: Record<string, string>;
}

/** What the View needs that would otherwise be a DB/Discord call, injected so its tests never hit any of them. */
export interface MemberAdminDeps {
    load(): Promise<MemberAdminSnapshot>;
    pause(): Promise<void>;
    unpause(): Promise<void>;
    /** Adds the given amounts (negative takes away). */
    grant(seeds: number, xp: number): Promise<void>;
    /** Makes a new channel and webhook; resolves with the text to show the admin. */
    setup(dmUser: boolean): Promise<string>;
    /** Registers an existing channel with its webhook; resolves with the text to show the admin. */
    adopt(channelId: string, webhookUrl: string): Promise<string>;
    /** False once the member has left the server. */
    stillInGuild(): Promise<boolean>;
    channelName(channelId: string): string;
    unlink(): Promise<void>;
    /** What a reset would erase, read now. */
    resetPreview(): Promise<ResetTotals>;
    reset(): Promise<ResetTotals>;
    deleteEverything(): Promise<void>;
    /** Adds or removes finds of a biome; never goes below zero. */
    adjustBiome(biome: string, delta: number): Promise<void>;
    setBiomeCount(biome: string, count: number): Promise<void>;
    giveBadge(badge: string): Promise<void>;
    takeBadge(badge: string): Promise<void>;
    /** False when the role is managed or not below the bot's highest role. */
    canAssignRole(roleId: string): boolean;
    sessionTotal(): Promise<number>;
    deleteSessions(ids: number[]): Promise<number>;
    clearSessions(): Promise<number>;
}

export type MemberAdminInput = undefined;

export type MemberScreen = "main" | "channel" | "existing" | "biome" | "danger";

export interface MemberAdminState extends MemberAdminSnapshot {
    tab: string;
    screen: MemberScreen;
    /** The page of the Badges or Sessions tab. */
    page: number;
    /** The biome in the editor. */
    biome: string | null;
}

export function defaultMemberAdminDeps(client: BotClient, guild: Guild, member: GuildMember): MemberAdminDeps {
    const userId = async () => {
        const user = await getUserByDiscordId(guild.id, member.id);
        if (!user) throw new BiomeHuntError("That user has no profile yet.");
        return user.id;
    };
    return {
        load: async () => {
            const [data, autoDelete, config, roles] = await Promise.all([
                loadProfileData(guild.id, member.id),
                isFlagEnabled(guild.id, "AUTO_DELETE_ENABLED"),
                getOrCreateGuildConfig(guild.id),
                getGuildBadgeRoles(guild.id),
            ]);
            const row = data ? await getMacroChannelByUserId(data.user.id) : null;
            const webhookWorking = row
                ? await client.fetchWebhook(row.webhook_id).then(
                      () => true,
                      () => false,
                  )
                : false;
            return {
                data,
                channel: row ? { channelId: row.channel_id, createdAt: row.created_at, webhookWorking } : null,
                autoDelete,
                deleteAfterS: config.delete_inactive_after_s,
                sessionTotal: data ? await countSessionsForUser(data.user.id) : 0,
                badgeRoles: Object.fromEntries(roles.map((r) => [r.badge, r.role_id])),
            };
        },
        pause: async () => {
            await pauseMember(guild.id, member.id);
        },
        unpause: async () => {
            await unpauseMember(guild.id, member.id);
        },
        grant: async (seeds, xp) => {
            await grantEconomy(guild.id, member.id, seeds || null, xp || null);
        },
        setup: (dmUser) => forceSetupMember(client, guild, member, dmUser, null),
        adopt: async (channelId, webhookUrl) => {
            const channel = await guild.channels.fetch(channelId).catch(() => null);
            if (!channel?.isTextBased() || channel.isDMBased() || channel.isThread() || channel.isVoiceBased()) {
                throw new BiomeHuntError("Pick a text channel.");
            }
            return forceSetupMember(client, guild, member, false, { channel: channel as never, webhookUrl });
        },
        stillInGuild: () =>
            guild.members.fetch(member.id).then(
                () => true,
                (err: { code?: number }) => {
                    if (err?.code === 10007) return false;
                    throw err;
                },
            ),
        channelName: (channelId) => guild.channels.cache.get(channelId)?.name ?? "channel",
        unlink: () => unlinkMember(client, guild.id, member.id),
        resetPreview: async () => {
            const user = await getUserByDiscordId(guild.id, member.id);
            if (!user) throw new BiomeHuntError("That user has no profile yet.");
            const [sessions, biomes, badges] = await Promise.all([
                countSessionsForUser(user.id),
                getBiomeCounts(user.id),
                getUserBadges(user.id),
            ]);
            return {
                sessions,
                finds: biomes.reduce((sum, b) => sum + b.count, 0),
                badges: badges.length,
                seeds: user.seeds,
                xp: user.xp,
            };
        },
        reset: () => resetMemberProgress(guild.id, member.id),
        deleteEverything: async () => {
            await deleteMemberEverything(client, guild.id, member.id);
        },
        adjustBiome: async (biome, delta) => {
            const id = await userId();
            const current = await getBiomeCountForUser(id, biome);
            await setBiomeCount(id, biome, Math.max(0, current + delta));
        },
        setBiomeCount: async (biome, count) => setBiomeCount(await userId(), biome, count),
        giveBadge: async (badge) => {
            await awardBadge(guild.id, member.id, badge);
        },
        takeBadge: async (badge) => {
            await takeBadge(guild.id, member.id, badge);
        },
        canAssignRole: (roleId) => canBotAssignRole(guild, roleId),
        sessionTotal: async () => countSessionsForUser(await userId()),
        deleteSessions: async (ids) => deleteSessions(await userId(), ids),
        clearSessions: async () => deleteAllSessionsForUser(await userId()),
    };
}

type Ctx = HandlerContext<MemberAdminState, void>;

const WHOLE_NUMBER = /^[+-]?\d+$/;

/** A form field as a whole number: empty = 0, `undefined` = not a number. */
function fieldAmount(raw: string | undefined): number | undefined {
    const text = (raw ?? "").trim();
    if (text === "") return 0;
    return WHOLE_NUMBER.test(text) ? Number(text) : undefined;
}

/** The "Gone: ..." line of a reset. */
function formatTotals(t: ResetTotals): string {
    return [
        plural(t.sessions, "session"),
        plural(t.finds, "biome find"),
        plural(t.badges, "badge"),
        `\`${t.seeds.toLocaleString("en-US")} 🌱\``,
        `\`${t.xp.toLocaleString("en-US")} XP\``,
    ].join(", ");
}

/**
 * The "Recreate the macro channel?" question: two ways to go ahead and Cancel. Runs `recreate` itself
 * (it can be slow) and resolves with its text, or `null` on Cancel or a failure.
 */
function recreateChoice(channelId: string | null, recreate: (dmUser: boolean) => Promise<string>) {
    const choose = (dmUser: boolean) => async (c: HandlerContext<{ phase: "asking" }, string | null>) => {
        try {
            c.done(await recreate(dmUser));
        } catch (err) {
            const described = describeCommandError(err);
            if (described.kind !== "user") throw err;
            await c.notify(described.message);
            c.done(null);
        }
    };
    return defineView<{ phase: "asking" }, string | null, void>({
        name: "biomehunt.member-recreate",
        initial: () => ({ phase: "asking" }),
        render: (_s, kit) => ({
            flags: MessageFlags.IsComponentsV2,
            components: [
                new ContainerBuilder()
                    .setAccentColor(RED)
                    .addTextDisplayComponents((td) =>
                        td.setContent(
                            `**Recreate the macro channel?**\n${channelId ? `<#${channelId}> is deleted and a` : "A"} new channel gets a new webhook.`,
                        ),
                    ),
                kit.row(
                    kit.button("dm", (b) => b.setLabel("Recreate and DM them").setStyle(ButtonStyle.Danger)),
                    kit.button("only", (b) => b.setLabel("Recreate only").setStyle(ButtonStyle.Danger)),
                    kit.button("cancel", (b) => b.setLabel("Cancel")),
                ),
            ],
            allowedMentions: NO_PINGS,
        }),
        on: {
            dm: choose(true),
            only: choose(false),
            cancel: (c) => c.done(null),
        },
    });
}

const tabPages = (s: MemberAdminState) => {
    if (!s.data) return 1;
    return s.tab === "badges" ? badgePages(s.data) : sessionPages(s.data);
};

/**
 * `/admin member`: everything an admin does to one member. Opens on the member's profile with an
 * Admin box, and tabs for Biomes, Badges and Sessions; a member with no profile gets the setup buttons.
 */
export function memberAdminView(member: GuildMember, deps: MemberAdminDeps): ViewDefinition<MemberAdminState, void, MemberAdminInput> {
    const name = member.user.username;

    /** Reads the panel again and keeps the page in range. */
    async function reload(s: MemberAdminState): Promise<void> {
        Object.assign(s, await deps.load());
        s.page = Math.min(s.page, tabPages(s) - 1);
    }

    /** Runs a change; a failure the admin can act on is shown as a notice. */
    async function attempt<T>(c: Ctx, run: () => Promise<T>): Promise<{ value: T } | null> {
        try {
            return { value: await run() };
        } catch (err) {
            const described = describeCommandError(err);
            if (described.kind !== "user") throw err;
            await c.notify(described.message);
            return null;
        }
    }

    const goTo = (screen: MemberScreen) => (c: Ctx) => {
        c.state.screen = screen;
    };

    /** True while the member is in the server; otherwise tells the admin and returns false. */
    async function present(c: Ctx): Promise<boolean> {
        if (await deps.stillInGuild()) return true;
        await c.notify("That user isn't in this server.");
        return false;
    }

    /** Back to the Profile tab. */
    const home = (c: Ctx) => {
        Object.assign(c.state, { tab: "profile", screen: "main", page: 0, biome: null });
    };

    /** A danger-zone form: the description, then the member's name to confirm. */
    async function nameForm(c: Ctx, title: string, text: string, run: () => Promise<void>): Promise<void> {
        const values = await c.modal({
            title: `${title}: ${name}`.slice(0, 45),
            text,
            fields: [
                {
                    key: "confirm",
                    label: `Type ${name} to confirm`.length > 45 ? "Type their username to confirm" : `Type ${name} to confirm`,
                    placeholder: name,
                    required: true,
                    maxLength: 40,
                },
            ],
        });
        if (!values) return;
        if ((values.confirm ?? "").trim() !== name) {
            await c.notify(`Nothing was done. Type \`${name}\` to confirm.`);
            return;
        }
        await run();
    }

    // --- Profile tab ---

    const togglePause = (pause: boolean) => async (c: Ctx) => {
        if (await attempt(c, () => (pause ? deps.pause() : deps.unpause()))) await reload(c.state);
    };

    const adjust = async (c: Ctx) => {
        const user = c.state.data?.user;
        if (!user) return;
        const values = await c.modal({
            title: `Adjust ${name}'s Seeds and XP`.slice(0, 45),
            fields: [
                {
                    key: "seeds",
                    label: `Seeds to add (now ${user.seeds.toLocaleString("en-US")})`,
                    placeholder: "0",
                    required: false,
                    maxLength: 12,
                },
                {
                    key: "xp",
                    label: `XP to add (now ${user.xp.toLocaleString("en-US")})`,
                    placeholder: "0",
                    required: false,
                    maxLength: 12,
                },
            ],
        });
        if (!values) return;
        const seeds = fieldAmount(values.seeds);
        const xp = fieldAmount(values.xp);
        if (seeds === undefined || xp === undefined) {
            await c.notify(`${seeds === undefined ? "Seeds" : "XP"} to add isn't a whole number. Try \`-200\` or \`50\`.`);
            return;
        }
        if (seeds === 0 && xp === 0) {
            await c.notify("Nothing to change.");
            return;
        }
        if (await attempt(c, () => deps.grant(seeds, xp))) await reload(c.state);
    };

    // --- Macro channel ---

    const recreate = async (c: Ctx) => {
        if (!(await present(c))) return;
        const text = await c.open(recreateChoice(c.state.channel?.channelId ?? null, deps.setup), undefined);
        await reload(c.state);
        home(c);
        if (text) await c.notify(text);
    };

    const pickExisting = async (c: Ctx) => {
        const channelId = c.values[0];
        if (!channelId) return;
        const values = await c.modal({
            title: `Webhook for #${deps.channelName(channelId)}`.slice(0, 45),
            fields: [
                { key: "url", label: "Webhook URL", placeholder: "https://discord.com/api/webhooks/…", required: true, maxLength: 200 },
            ],
        });
        if (!values) return;
        if (!(await present(c))) return;
        const adopted = await attempt(c, () => deps.adopt(channelId, (values.url ?? "").trim()));
        if (!adopted) return;
        await reload(c.state);
        home(c);
        await c.notify(adopted.value);
    };

    const setupFor = (dmUser: boolean) => async (c: Ctx) => {
        if (!(await present(c))) return;
        const made = await attempt(c, () => deps.setup(dmUser));
        if (!made) return;
        await reload(c.state);
        home(c);
        await c.notify(made.value);
    };

    // --- Biomes ---

    const editBiome = (delta: number) => async (c: Ctx) => {
        const { biome } = c.state;
        if (biome && (await attempt(c, () => deps.adjustBiome(biome, delta)))) await reload(c.state);
    };

    const setCount = async (c: Ctx) => {
        const { biome, data } = c.state;
        if (!biome || !data) return;
        const values = await c.modal({
            title: `Set ${formatBiomeName(biome)} count`.slice(0, 45),
            fields: [{ key: "count", label: "Finds", placeholder: String(biomeCount(data, biome)), required: true, maxLength: 7 }],
        });
        if (!values) return;
        const text = (values.count ?? "").trim();
        if (!/^\d+$/.test(text)) {
            await c.notify("Finds must be a whole number, zero or more.");
            return;
        }
        if (await attempt(c, () => deps.setBiomeCount(biome, Number(text)))) await reload(c.state);
    };

    const removeAll = async (c: Ctx) => {
        const { biome, data } = c.state;
        if (!biome || !data) return;
        const label = formatBiomeName(biome);
        const removed = await c.open(
            confirm({
                name: "biomehunt.member-clear-biome",
                title: `Remove all ${biomeCount(data, biome)} ${label} finds?`,
                body: ["", `-# The ${label} badge stays. To take it too, use the Badges tab.`],
                color: RED,
                confirmLabel: "Remove all",
                confirmStyle: ButtonStyle.Danger,
                cancelStyle: ButtonStyle.Secondary,
                onConfirm: async () => {
                    await deps.setBiomeCount(biome, 0);
                    return EmbedFormatter.success(`Removed all ${label} finds.`);
                },
            }),
            undefined,
        );
        if (removed) await reload(c.state);
    };

    // --- Badges ---

    const badgeButton = (slot: number) => async (c: Ctx) => {
        const { data, page, badgeRoles } = c.state;
        const badge = data ? badgeOnPage(data, page, slot) : undefined;
        if (!data || !badge) return;
        const meta = getBadgeMeta(badge);
        const roleId = badgeRoles[badge];
        if (!data.badges.some((b) => b.badge === badge)) {
            if (!(await present(c))) return;
            if (!(await attempt(c, () => deps.giveBadge(badge)))) return;
            await reload(c.state);
            if (roleId && !deps.canAssignRole(roleId)) await c.notify(`I can't give <@&${roleId}> - it's above my highest role.`);
            return;
        }
        if (!(await present(c))) return;
        const taken = await c.open(
            confirm({
                name: "biomehunt.member-take-badge",
                title: "Take this badge?",
                body: `**${meta.emoji} ${meta.display}** from <@${member.id}>.${roleId ? ` They also lose the <@&${roleId}> role.` : ""}`,
                color: RED,
                confirmLabel: "Take",
                confirmStyle: ButtonStyle.Danger,
                cancelStyle: ButtonStyle.Secondary,
                onConfirm: async () => {
                    await deps.takeBadge(badge);
                    return EmbedFormatter.success("Badge taken.");
                },
            }),
            undefined,
        );
        if (taken) await reload(c.state);
    };

    // --- Sessions ---

    const deleteChosen = async (c: Ctx) => {
        const { data, page } = c.state;
        if (!data) return;
        const ids = c.values.map(Number);
        const chosen = sessionsOnPage(data, page).filter((x) => ids.includes(x.id));
        if (chosen.length === 0) return;
        const deleted = await c.open(
            confirm({
                name: "biomehunt.member-delete-sessions",
                title: `Delete ${plural(chosen.length, "session")}?`,
                body: [
                    chosen.map((x) => `\`#${x.id}\` · \`${formatTime(x.duration_seconds)}\``).join("\n"),
                    "-# If these sessions are recent, deleting them may affect their quotas.",
                ],
                color: RED,
                confirmLabel: "Delete",
                confirmStyle: ButtonStyle.Danger,
                cancelStyle: ButtonStyle.Secondary,
                onConfirm: async () => {
                    await deps.deleteSessions(chosen.map((x) => x.id));
                    return EmbedFormatter.success("Sessions deleted.");
                },
            }),
            undefined,
        );
        if (deleted) await reload(c.state);
    };

    const clearAll = async (c: Ctx) => {
        const total = await deps.sessionTotal();
        if (total === 0) {
            await c.notify("No sessions to delete.");
            return;
        }
        const cleared = await c.open(
            confirm({
                name: "biomehunt.member-clear-sessions",
                title: `Delete all ${plural(total, "session")}?`,
                body: ["", "-# If these sessions are recent, deleting them may affect their quotas."],
                color: RED,
                confirmLabel: "Delete",
                confirmStyle: ButtonStyle.Danger,
                cancelStyle: ButtonStyle.Secondary,
                onConfirm: async () => {
                    await deps.clearSessions();
                    return EmbedFormatter.success("Sessions deleted.");
                },
            }),
            undefined,
        );
        if (cleared) await reload(c.state);
    };

    // --- Danger zone ---

    const unlink = (c: Ctx) =>
        nameForm(
            c,
            "Unlink member",
            "Deletes their macro channel. Profile, sessions, biomes, badges, quota status, Seeds and XP all stay. If they come back, `/bh setup` gives them a new channel and everything is still there.",
            async () => {
                if (!(await attempt(c, () => deps.unlink()))) return;
                await reload(c.state);
                home(c);
                await c.notify(`Unlinked ${name}. Their data stays.`);
            },
        );

    const reset = async (c: Ctx) => {
        let gone = "";
        try {
            gone = formatTotals(await deps.resetPreview());
        } catch (err) {
            if (describeCommandError(err).kind !== "user") throw err;
            await c.notify("That user has no profile yet.");
            return;
        }
        await nameForm(
            c,
            "Reset member",
            `Erases their progress here: sessions, biomes, badges, quota status, Seeds and XP. Their macro channel and Flower stay, so they keep macroing from zero. Works on unlinked members too.\n\nGone: ${gone}.`,
            async () => {
                const erased = await attempt(c, () => deps.reset());
                if (!erased) return;
                await reload(c.state);
                home(c);
                await c.notify(`Reset ${name}. Gone: ${formatTotals(erased.value)}.`);
            },
        );
    };

    const deleteAll = (c: Ctx) =>
        nameForm(
            c,
            "Delete everything",
            "Deletes their whole profile here, macro channel included. If they run `/bh setup` again, they start as a new member.",
            async () => {
                if (!(await attempt(c, () => deps.deleteEverything()))) return;
                await reload(c.state);
                home(c);
                await c.notify(`Deleted everything for ${name}.`);
            },
        );

    return defineView<MemberAdminState, void, MemberAdminInput>({
        name: "biomehunt.member",
        initial: async () => ({ ...(await deps.load()), tab: "profile", screen: "main", page: 0, biome: null }),
        render: renderMemberAdmin(member),
        on: {
            ...paginationHandlers<MemberAdminState>({ pages: tabPages }),
            ...Object.fromEntries(
                MEMBER_TABS.map((t) => [
                    `tab:${t.key}`,
                    (c: Ctx) => {
                        Object.assign(c.state, { tab: t.key, page: 0 });
                    },
                ]),
            ),
            back: (c) => {
                if (c.state.screen === "biome") Object.assign(c.state, { screen: "main", biome: null });
                else home(c);
            },

            manage: goTo("channel"),
            pause: togglePause(true),
            resume: togglePause(false),
            adjust,
            danger: goTo("danger"),

            recreate,
            existing: goTo("existing"),
            existingChannel: pickExisting,
            cancelExisting: home,
            setupDm: setupFor(true),
            setupOnly: setupFor(false),

            pickBiome: (c) => {
                const biome = c.values[0];
                if (biome && c.state.data && editableBiomes(c.state.data).includes(biome))
                    Object.assign(c.state, { biome, screen: "biome" });
            },
            biomeDec: editBiome(-1),
            biomeInc: editBiome(1),
            biomeSet: setCount,
            biomeClear: removeAll,

            ...Object.fromEntries(Array.from({ length: 5 }, (_, slot) => [`badge:${slot}`, badgeButton(slot)])),

            inspectSession: async (c) => {
                const data = c.state.data;
                const id = Number(c.values[0]);
                if (!data || !sessionsOnPage(data, c.state.page).some((x) => x.id === id)) return;
                const input = await loadSessionInput(data.user.guild_id, id);
                if (!input) {
                    await c.notify(`No session \`#${id}\` on this server.`);
                    return;
                }
                await c.open(sessionView({ back: true }), input);
            },
            deleteSessions: deleteChosen,
            clearSessions: clearAll,

            unlink,
            reset,
            deleteAll,
        },
    });
}
