import { ButtonStyle } from "discord.js";
import { confirm, defineView, type HandlerContext, type ViewDefinition } from "@/define";
import { EmbedFormatter } from "@/utils/format";
import { validateCapture } from "../services/capture";
import { accessMessage, type ChannelAccess } from "../services/channel-access";
import { type SaveOutcome, type StickyService, savedLine } from "../services/sticky.service";
import { StickyError, type StickyMode } from "../types";
import { renderPanel } from "./panel.screens";

export type PanelScreen = "list" | "detail" | "pickChannel" | "capture";

type Overview = Awaited<ReturnType<StickyService["overview"]>>;

export interface PanelState {
    screen: PanelScreen;
    overview: Overview;
    /** Channel id -> name, for the list select's labels. */
    names: Record<string, string>;
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
    /** Channel name for the list select; defaults to the id. */
    channelName?(channelId: string): string | undefined;
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
        s.names = Object.fromEntries(s.overview.stickies.map((x) => [x.channel_id, deps.channelName?.(x.channel_id) ?? x.channel_id]));
        if (s.screen === "detail" && !s.overview.stickies.some((x) => x.channel_id === s.channelId)) {
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

    const change = (apply: (channelId: string, value: string) => Promise<unknown>) => async (c: Ctx) => {
        const { channelId } = c.state;
        const value = c.values[0];
        if (!channelId || !value) return;
        await attempt(c, () => apply(channelId, value));
        await reload(c.state);
    };

    return defineView<PanelState, void, void>({
        name: "sticky.panel",
        initial: async () => {
            const state: PanelState = {
                screen: "list",
                overview: await service.overview(guildId),
                names: {},
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
            pick: async (c) => {
                const channelId = c.values[0];
                if (!channelId) return;
                if (deps.access(channelId) === "user_cannot_manage") {
                    await c.notify(accessMessage.user_cannot_manage(channelId));
                    return;
                }
                Object.assign(c.state, { screen: "detail", channelId });
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
