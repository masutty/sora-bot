import { ButtonStyle, type Guild, PermissionFlagsBits } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { confirm, defineView, type HandlerContext, paginationHandlers, type ViewDefinition } from "@/define";
import { EmbedFormatter } from "@/utils/format";
import { formatBiomeName } from "../constants/biomes.constants";
import { getDelayedForwardConfigs, removeDelayedForwardConfig } from "../repository/delayed-forwards.repository";
import { getForwardConfig, getForwardConfigs, removeForwardConfig, setForwardConfig } from "../repository/forwards.repository";
import { getNetworkGuild } from "../repository/network.repository";
import { setDelayedForward } from "../services/delayed-forward.service";
import { type BiomeCategory, type BiomeDelayedForwardRow, type BiomeForwardRow, NetworkStatus } from "../types";
import { buildTestForwardPost } from "./forward-post.view";
import {
    DEFAULT_DELAY_S,
    FORWARD_TABS,
    FORWARDS_PER_PAGE,
    forwardPages,
    isRare,
    NETWORK_NOTE,
    renderForwards,
    showNetworkNotes,
    TAB_NOUN,
    tabBiomes,
} from "./forwards.screens";

const RED = 0xda373c;
const ORANGE = 0xf0b232;

/** What the View needs that would otherwise be a DB/Discord call, injected so its tests never hit any of them. */
export interface ForwardsDeps {
    getForwards(): Promise<BiomeForwardRow[]>;
    getDelayedForwards(): Promise<BiomeDelayedForwardRow[]>;
    setForward(biome: string, channelId: string, roleId: string | null): Promise<void>;
    removeForward(biome: string): Promise<void>;
    /** Rare biomes only. */
    setDelayed(biome: string, channelId: string, roleId: string | null, delayS: number): Promise<void>;
    removeDelayed(biome: string): Promise<void>;
    /** Whether the bot can see the channel and send in it. */
    canPost(channelId: string): Promise<boolean>;
    networkStatus(): Promise<NetworkStatus>;
    /** Posts the biome's test post (no pings) in its forward channel; throws when it can't. */
    sendTest(biome: string, adminId: string): Promise<void>;
}

export type ForwardsInput = undefined;

export type ForwardsScreen = "list" | "editor" | "all";

/** The "Set for all" form: nothing is written until Apply. */
export interface ForwardsAllDraft {
    channelId: string | null;
    lateChannelId: string | null;
    /** `null` = not touched. */
    delayS: number | null;
    copyPings: boolean;
}

export interface ForwardsState {
    screen: ForwardsScreen;
    tab: BiomeCategory;
    page: number;
    /** The biome in the editor. */
    biome: string | null;
    forwards: Record<string, BiomeForwardRow>;
    delayed: Record<string, BiomeDelayedForwardRow>;
    /** Forward channels the bot can't post in. */
    blocked: string[];
    network: NetworkStatus;
    all: ForwardsAllDraft;
}

export function defaultForwardsDeps(_client: BotClient, guild: Guild): ForwardsDeps {
    const textChannel = async (channelId: string) => {
        const channel = await guild.channels.fetch(channelId).catch(() => null);
        return channel?.isTextBased() && !channel.isDMBased() ? channel : null;
    };
    return {
        getForwards: () => getForwardConfigs(guild.id),
        getDelayedForwards: () => getDelayedForwardConfigs(guild.id),
        setForward: (biome, channelId, roleId) => setForwardConfig(guild.id, biome, channelId, roleId),
        removeForward: async (biome) => {
            await removeForwardConfig(guild.id, biome);
        },
        setDelayed: async (biome, channelId, roleId, delayS) => {
            await setDelayedForward(guild.id, biome, channelId, roleId, delayS);
        },
        removeDelayed: async (biome) => {
            await removeDelayedForwardConfig(guild.id, biome);
        },
        canPost: async (channelId) => {
            const channel = await textChannel(channelId);
            const me = guild.members.me;
            if (!channel || !me) return false;
            return channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]) ?? false;
        },
        networkStatus: async () => (await getNetworkGuild(guild.id))?.status ?? NetworkStatus.NONE,
        sendTest: async (biome, adminId) => {
            const [now, late] = await Promise.all([getForwardConfig(guild.id, biome), getDelayedForwardConfigs(guild.id)]);
            const config = now ?? late.find((d) => d.biome === biome);
            const channel = config ? await textChannel(config.channel_id) : null;
            if (!config || !channel) throw new Error("No channel to send the test to.");
            await channel.send(buildTestForwardPost(biome, config.role_id, adminId));
        },
    };
}

type Ctx = HandlerContext<ForwardsState, void>;

const byBiome = <T extends { biome: string }>(rows: T[]) => Object.fromEntries(rows.map((r) => [r.biome, r]));

const emptyDraft = (): ForwardsAllDraft => ({ channelId: null, lateChannelId: null, delayS: null, copyPings: false });

/** The delay a "Set for all" draft gives delayed forwards; `null` when it leaves delays alone. */
const draftDelay = (d: ForwardsAllDraft) => (d.lateChannelId ? (d.delayS ?? DEFAULT_DELAY_S) : d.delayS);

/**
 * `/bh-admin forwards`: where each biome find gets posted, right away and (rare only) after a delay.
 * A tab per category, an editor per biome whose selects save on change, and "Set for all" for a category.
 */
export function forwardsView(deps: ForwardsDeps): ViewDefinition<ForwardsState, void, ForwardsInput> {
    /** The fresh rows, for a decision that must not trust the state. */
    async function freshRows() {
        const [now, late] = await Promise.all([deps.getForwards(), deps.getDelayedForwards()]);
        return { now, late };
    }

    /** Re-reads both forwards and checks the bot can still post in each channel. */
    async function reload(s: ForwardsState): Promise<void> {
        const { now, late } = await freshRows();
        s.forwards = byBiome(now);
        s.delayed = byBiome(late);
        const ids = [...new Set([...now, ...late].map((f) => f.channel_id))];
        const ok = await Promise.all(ids.map((id) => deps.canPost(id)));
        s.blocked = ids.filter((_, i) => !ok[i]);
    }

    // --- Editor: each select saves on change ---

    async function setNow(c: Ctx, patch: { channelId?: string | null; roleId?: string | null }): Promise<void> {
        const { biome } = c.state;
        if (!biome) return;
        const current = c.state.forwards[biome];
        const channelId = patch.channelId === undefined ? (current?.channel_id ?? null) : patch.channelId;
        if (!channelId) {
            if (patch.roleId) {
                await c.notify("Pick the channel first.");
                return;
            }
            await deps.removeForward(biome);
        } else {
            const roleId = patch.roleId === undefined ? (current?.role_id ?? null) : patch.roleId;
            await deps.setForward(biome, channelId, roleId);
        }
        await reload(c.state);
    }

    async function setLate(c: Ctx, patch: { channelId?: string | null; roleId?: string | null; delayS?: number }): Promise<void> {
        const { biome } = c.state;
        if (!biome) return;
        const current = c.state.delayed[biome];
        const channelId = patch.channelId === undefined ? (current?.channel_id ?? null) : patch.channelId;
        if (!channelId) {
            if (patch.roleId || patch.delayS !== undefined) {
                await c.notify("Pick the delayed channel first.");
                return;
            }
            await deps.removeDelayed(biome);
        } else {
            const roleId = patch.roleId === undefined ? (current?.role_id ?? null) : patch.roleId;
            await deps.setDelayed(biome, channelId, roleId, patch.delayS ?? current?.delay_s ?? DEFAULT_DELAY_S);
        }
        await reload(c.state);
    }

    const stop = async (c: Ctx) => {
        const { biome } = c.state;
        if (!biome) return;
        const name = formatBiomeName(biome);
        const rare = isRare(biome);
        const network = showNetworkNotes(c.state) && rare;
        const stopped = await c.open(
            confirm({
                name: "biomehunt.forwards-stop",
                title: `Stop forwarding ${name}?`,
                body: [rare ? "Its Now and delayed forwards both stop." : "Its forward stops.", ...(network ? [`-# ${NETWORK_NOTE}`] : [])],
                color: RED,
                confirmLabel: "Stop forwarding",
                confirmStyle: ButtonStyle.Danger,
                cancelStyle: ButtonStyle.Secondary,
                onConfirm: async () => {
                    await deps.removeForward(biome);
                    await deps.removeDelayed(biome);
                    return EmbedFormatter.success(`${name} is no longer forwarded.`);
                },
            }),
            undefined,
        );
        if (!stopped) return;
        await reload(c.state);
        c.state.screen = "list";
    };

    const test = async (c: Ctx) => {
        const { biome } = c.state;
        const config = biome ? (c.state.forwards[biome] ?? c.state.delayed[biome]) : undefined;
        if (!biome || !config) {
            await c.notify("Pick a channel first.");
            return;
        }
        try {
            await deps.sendTest(biome, c.user.id);
        } catch {
            await c.notify(`I couldn't post in <#${config.channel_id}>.`);
            return;
        }
        await c.notify(`Test post sent to <#${config.channel_id}>.`);
    };

    // --- Set for all ---

    /** What the draft would overwrite with a different value, from a fresh read: one line per biome. */
    async function overwriteLines(s: ForwardsState): Promise<string[]> {
        const d = s.all;
        const { now, late } = await freshRows();
        const nowByBiome = byBiome(now);
        const lateByBiome = byBiome(late);
        const delay = draftDelay(d);
        const lines: string[] = [];
        for (const biome of tabBiomes(s.tab)) {
            const name = formatBiomeName(biome);
            const cur = nowByBiome[biome];
            if (d.channelId && cur && cur.channel_id !== d.channelId) {
                lines.push(`**Now:** ${name} is currently forwarding to <#${cur.channel_id}>.`);
            }
        }
        if (s.tab === "rare") {
            for (const biome of tabBiomes(s.tab)) {
                const cur = lateByBiome[biome];
                if (!cur) continue;
                const channelDiffers = d.lateChannelId !== null && cur.channel_id !== d.lateChannelId;
                const delayDiffers = delay !== null && cur.delay_s !== delay;
                if (channelDiffers || delayDiffers) {
                    lines.push(
                        `**After a delay:** ${formatBiomeName(biome)} is currently forwarding to <#${cur.channel_id}> after ${cur.delay_s}s.`,
                    );
                }
            }
        }
        return lines;
    }

    /** Writes the draft to every biome of the tab. Each biome keeps its own Now ping. */
    async function applyAll(s: ForwardsState): Promise<void> {
        const d = s.all;
        const { now, late } = await freshRows();
        const nowByBiome = byBiome(now);
        const lateByBiome = byBiome(late);
        const delay = draftDelay(d);
        for (const biome of tabBiomes(s.tab)) {
            const nowRole = nowByBiome[biome]?.role_id ?? null;
            if (d.channelId) await deps.setForward(biome, d.channelId, nowRole);
            if (s.tab !== "rare") continue;
            const cur = lateByBiome[biome];
            const channelId = d.lateChannelId ?? cur?.channel_id;
            const touched = d.lateChannelId !== null || delay !== null || (d.copyPings && cur !== undefined);
            if (!channelId || !touched) continue;
            await deps.setDelayed(
                biome,
                channelId,
                d.copyPings ? nowRole : (cur?.role_id ?? null),
                delay ?? cur?.delay_s ?? DEFAULT_DELAY_S,
            );
        }
        await reload(s);
    }

    const apply = async (c: Ctx) => {
        const { state } = c;
        const d = state.all;
        if (!d.channelId && !d.lateChannelId && d.delayS === null && !d.copyPings) {
            await c.notify("Pick a channel first.");
            return;
        }
        const lines = await overwriteLines(state);
        if (lines.length === 0) {
            await applyAll(state);
            state.screen = "list";
            return;
        }
        const count = tabBiomes(state.tab).length;
        const applied = await c.open(
            confirm({
                name: "biomehunt.forwards-apply-all",
                title: `Apply to all ${count} ${TAB_NOUN[state.tab] ?? "biomes"}?`,
                body: lines.join("\n"),
                color: ORANGE,
                confirmLabel: `Apply to all ${count}`,
                confirmStyle: ButtonStyle.Primary,
                cancelStyle: ButtonStyle.Secondary,
                onConfirm: async () => {
                    await applyAll(state);
                    return EmbedFormatter.success("Applied.");
                },
            }),
            undefined,
        );
        if (applied) state.screen = "list";
    };

    return defineView<ForwardsState, void, ForwardsInput>({
        name: "biomehunt.forwards",
        initial: async () => {
            const state: ForwardsState = {
                screen: "list",
                tab: "rare",
                page: 0,
                biome: null,
                forwards: {},
                delayed: {},
                blocked: [],
                network: await deps.networkStatus(),
                all: emptyDraft(),
            };
            await reload(state);
            return state;
        },
        render: renderForwards,
        on: {
            ...paginationHandlers<ForwardsState>({ pages: (s) => forwardPages(s.tab) }),
            ...Object.fromEntries(
                FORWARD_TABS.map((t) => [
                    `tab:${t.key}`,
                    (c: Ctx) => {
                        Object.assign(c.state, { tab: t.key, page: 0, screen: "list" });
                    },
                ]),
            ),
            ...Object.fromEntries(
                Array.from({ length: FORWARDS_PER_PAGE }, (_, slot) => [
                    `edit:${slot}`,
                    (c: Ctx) => {
                        const biome = tabBiomes(c.state.tab)[c.state.page * FORWARDS_PER_PAGE + slot];
                        if (biome) Object.assign(c.state, { biome, screen: "editor" });
                    },
                ]),
            ),
            close: (c) => c.done(),
            back: (c) => {
                c.state.screen = "list";
            },

            nowChannel: (c) => setNow(c, { channelId: c.values[0] ?? null }),
            nowRole: (c) => setNow(c, { roleId: c.values[0] ?? null }),
            lateChannel: (c) => setLate(c, { channelId: c.values[0] ?? null }),
            lateRole: (c) => setLate(c, { roleId: c.values[0] ?? null }),
            lateDelay: (c) => setLate(c, { delayS: Number(c.values[0]) }),
            test,
            stop,

            all: (c) => {
                c.state.all = emptyDraft();
                c.state.screen = "all";
            },
            allNow: (c) => {
                c.state.all.channelId = c.values[0] ?? null;
            },
            allLate: (c) => {
                c.state.all.lateChannelId = c.values[0] ?? null;
            },
            allDelay: (c) => {
                c.state.all.delayS = Number(c.values[0]);
            },
            allCopy: (c) => {
                c.state.all.copyPings = !c.state.all.copyPings;
            },
            apply,
        },
    });
}
