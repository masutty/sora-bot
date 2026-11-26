import { ButtonStyle } from "discord.js";
import { confirm, defineView, type HandlerContext, paginationHandlers, type ViewDefinition } from "@/define";
import { EmbedFormatter } from "@/utils/format";
import { validateCapture } from "../services/capture";
import { accessMessage, type ChannelAccess } from "../services/channel-access";
import { type SaveOutcome, type StickyService, savedLine } from "../services/sticky.service";
import { StickyError, type StickyMode } from "../types";
import { pageCount, renderPanel, STICKIES_PER_PAGE } from "./panel.screens";

export type PanelScreen = "list" | "detail" | "mode" | "delay" | "pickChannel" | "capture";

type Overview = Awaited<ReturnType<StickyService["overview"]>>;

export interface PanelState {
    screen: PanelScreen;
    /** Page of the list screen (0-based). */
    page: number;
    overview: Overview;
    /** The sticky in detail, or the channel being captured. */
    channelId: string | null;
    /** Whether the capture creates a sticky or replaces the text of `channelId`'s. */
    capturing: "create" | "edit";
    /** Channels the pickChannel screen lists (sorted, no sticky, usable by user and bot); null shows the full channel select. */
    eligible: PanelChannel[] | null;
}

export interface PanelChannel {
    id: string;
    name: string;
    position: number;
}

/** A string select holds at most 25 options. */
const MAX_ELIGIBLE = 25;

export interface PanelDeps {
    guildId: string;
    userId: string;
    service: StickyService;
    access(channelId: string): ChannelAccess;
    /** Text and announcement channels of the server; without it the pickChannel screen uses a channel select. */
    channels?(): PanelChannel[];
}

type Ctx = HandlerContext<PanelState, void>;

const RED = 0xda373c;

/** `/sticky panel`: this server's stickies - create, edit, change mode and delay, delete. */
export function stickyPanelView(deps: PanelDeps): ViewDefinition<PanelState, void, void> {
    const { service, guildId } = deps;

    async function reload(s: PanelState): Promise<void> {
        s.overview = await service.overview(guildId);
        s.page = Math.min(s.page, pageCount(s.overview.stickies.length) - 1);
        if (
            (s.screen === "detail" || s.screen === "mode" || s.screen === "delay") &&
            !s.overview.stickies.some((x) => x.channel_id === s.channelId)
        ) {
            Object.assign(s, { screen: "list", channelId: null });
        }
    }

    /** Runs a service call; a StickyError is told to the user and leaves the screen as it was. */
    async function attempt(c: Ctx, action: () => Promise<unknown>): Promise<boolean> {
        try {
            await action();
            return true;
        } catch (err) {
            if (!(err instanceof StickyError)) throw err;
            await c.notify(err.message);
            return false;
        }
    }

    /** Tells the user why the channel can't be used; true when it can. */
    async function allowed(c: Ctx, channelId: string): Promise<boolean> {
        const access = deps.access(channelId);
        if (access === "ok") return true;
        await c.notify(accessMessage[access](channelId));
        return false;
    }

    function eligibleChannels(): PanelChannel[] | null {
        if (!deps.channels) return null;
        const list = deps
            .channels()
            .filter((ch) => !service.get(ch.id) && deps.access(ch.id) === "ok")
            .sort((a, b) => a.position - b.position);
        return list.length > MAX_ELIGIBLE ? null : list;
    }

    const toList = async (c: Ctx) => {
        await reload(c.state);
        Object.assign(c.state, { screen: "list", channelId: null });
    };

    /** Opens the sticky of slot `i` on the list's current page. */
    const open = (i: number) => async (c: Ctx) => {
        const channelId = c.state.overview.stickies[c.state.page * STICKIES_PER_PAGE + i]?.channel_id;
        if (!channelId) return;
        if (deps.access(channelId) === "user_cannot_manage") {
            await c.notify(accessMessage.user_cannot_manage(channelId));
            return;
        }
        Object.assign(c.state, { screen: "detail", channelId });
    };

    const change = (apply: (channelId: string, value: string) => Promise<unknown>) => async (c: Ctx) => {
        const { channelId } = c.state;
        const value = c.values[0];
        if (!channelId || !value) return;
        await attempt(c, () => apply(channelId, value));
        await reload(c.state);
        if (c.state.screen === "mode" || c.state.screen === "delay") c.state.screen = "detail";
    };

    return defineView<PanelState, void, void>({
        name: "sticky.panel",
        initial: async () => {
            const state: PanelState = {
                screen: "list",
                page: 0,
                overview: await service.overview(guildId),
                channelId: null,
                capturing: "create",
                eligible: null,
            };
            await reload(state);
            return state;
        },
        access: "invoker",
        deleteTextInput: true,
        render: renderPanel,
        on: {
            ...paginationHandlers<PanelState>({ pages: (s) => pageCount(s.overview.stickies.length) }),
            ...Object.fromEntries(Array.from({ length: STICKIES_PER_PAGE }, (_, i) => [`open:${i}`, open(i)])),
            changeMode: (c) => {
                c.state.screen = "mode";
            },
            changeDelay: (c) => {
                c.state.screen = "delay";
            },
            detail: (c) => {
                c.state.screen = "detail";
            },
            back: toList,
            create: (c) => {
                Object.assign(c.state, { screen: "pickChannel", channelId: null, capturing: "create", eligible: eligibleChannels() });
            },
            channel: async (c) => {
                const channelId = c.values[0];
                if (!channelId) return;
                if (service.get(channelId)) {
                    await c.notify(`<#${channelId}> already has a sticky.`);
                    return;
                }
                if (!(await allowed(c, channelId))) return;
                Object.assign(c.state, { screen: "capture", channelId, capturing: "create" });
            },
            mode: change((channelId, value) => service.setMode(channelId, value as StickyMode)),
            delay: change((channelId, value) => service.setDelay(channelId, Number(value))),
            editContent: async (c) => {
                const { channelId } = c.state;
                if (!channelId || !(await allowed(c, channelId))) return;
                Object.assign(c.state, { screen: "capture", capturing: "edit" });
            },
            cancel: (c) => {
                const { capturing, channelId } = c.state;
                Object.assign(c.state, capturing === "edit" && channelId ? { screen: "detail" } : { screen: "list", channelId: null });
            },
            delete: async (c) => {
                const { channelId } = c.state;
                if (!channelId) return;
                const removed = await c.open(
                    confirm({
                        name: "sticky.delete",
                        title: "Delete this sticky?",
                        body: `<#${channelId}>`,
                        color: RED,
                        confirmLabel: "Delete",
                        confirmStyle: ButtonStyle.Danger,
                        cancelStyle: ButtonStyle.Secondary,
                        onConfirm: async () => {
                            await service.remove(channelId);
                            return EmbedFormatter.success("Sticky deleted.");
                        },
                    }),
                    undefined,
                );
                if (removed) await toList(c);
            },
        },
        onText: async (c) => {
            const { channelId, capturing } = c.state;
            if (c.state.screen !== "capture" || !channelId) return;
            const checked = validateCapture(c.raw as never);
            if (!checked.ok) {
                await c.notify(checked.reason);
                return;
            }
            let outcome: SaveOutcome | undefined;
            const saved = await attempt(c, async () => {
                outcome =
                    capturing === "edit"
                        ? await service.editContent(channelId, checked.content)
                        : await service.create({ guildId, channelId, content: checked.content, userId: deps.userId });
            });
            if (!saved) return;
            if (outcome && !outcome.posted) await c.notify(savedLine(outcome, ""));
            await reload(c.state);
            Object.assign(c.state, { screen: "detail", channelId });
        },
    });
}
