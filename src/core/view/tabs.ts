import { ActionRowBuilder, type ButtonBuilder, ButtonStyle } from "discord.js";
import { type AnySelect, defineView, type RenderKit, type ViewDefinition, type ViewPayload } from "./view";

export interface TabSpec {
    /** The tab's id - `state.tab` holds it, and its button is bound to the key `tab:<key>`. */
    key: string;
    label: string;
    emoji?: string;
}

export interface TabRender {
    /** The tab's content. The tab row (then `extraRows`) is appended to its `components`. */
    payload: ViewPayload;
    /** The tab's own controls (e.g. prev/next of a list), bound to handlers in `on`. */
    extraRows?: ActionRowBuilder<ButtonBuilder | AnySelect>[];
}

export interface TabsOptions<T extends { tab: string }, I> {
    /** `<cog>.<name>` of the View. */
    name: string;
    /** Initial state; `tab` is the tab it opens on. Load data here (or pass it through `input`). */
    initial: (input: I) => T | Promise<T>;
    /** One button per tab, in order (5 per row). */
    tabs: TabSpec[];
    /** Pure: the active tab's content (`state.tab`) and its extra rows. */
    renderTab: (state: T, kit: RenderKit) => TabRender;
    /** Handlers for the tabs' own controls. Keys starting with `tab:` are taken by the tab buttons. */
    on?: ViewDefinition<T, void, I>["on"];
    /**
     * Runs after a tab click switched `state.tab` to `key` - mutate the state or return a new one
     * (e.g. reset a list's page). Not called for the tab the view opens on.
     */
    // biome-ignore lint/suspicious/noConfusingVoidType: same convention as HandlerResult - mutate (void) or return a state.
    onTabChange?: (state: T, key: string) => T | void;
    /**
     * Disables the active tab's button so it can't be reclicked - default `true`, the usual tab
     * look. Set `false` to let the active tab be reclicked (still Primary,
     * just not disabled): the click still sets `state.tab` to the same key and runs
     * `onTabChange` - useful when reclicking should reset something (e.g. a list's page).
     */
    disableActive?: boolean;
    /** Idle timeout when this is the root. Default config.ui.viewTimeoutMs. */
    timeoutMs?: number;
}

const TABS_PER_ROW = 5;

function tabRows(tabs: TabSpec[], active: string, kit: RenderKit, disableActive: boolean): ActionRowBuilder<ButtonBuilder>[] {
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    for (let i = 0; i < tabs.length; i += TABS_PER_ROW) {
        const buttons = tabs.slice(i, i + TABS_PER_ROW).map((t) =>
            kit.button(`tab:${t.key}`, (b) => {
                b.setLabel(t.label)
                    .setStyle(t.key === active ? ButtonStyle.Primary : ButtonStyle.Secondary)
                    .setDisabled(disableActive && t.key === active);
                return t.emoji ? b.setEmoji(t.emoji) : b;
            }),
        );
        rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons));
    }
    return rows;
}

/**
 * Tabs on one message: a button per tab (the active one Primary, and disabled by default - the
 * usual tab look; pass `disableActive: false` to leave it clickable) below the
 * tab's content, then the tab's own `extraRows`. Clicking a tab (including the already-active one,
 * with `disableActive: false`) sets `state.tab` (the rest of the state is kept), then runs
 * `onTabChange` if given.
 *
 * @example
 * const profile = tabs({
 *     name: "biomehunt.profile",
 *     initial: (data: ProfileData) => ({ tab: "profile", data, page: 0 }),
 *     tabs: [{ key: "profile", label: "Profile" }, { key: "sessions", label: "Sessions" }],
 *     renderTab: (s, kit) => s.tab === "profile"
 *         ? { payload: buildProfile(s.data) }
 *         : { payload: buildSessions(s.data, s.page), extraRows: [kit.row(kit.button("more", (b) => b.setLabel(">")))] },
 *     on: { more: (c) => { c.state.page++; } },
 *     onTabChange: (s) => { s.page = 0; },
 * });
 * await ctx.open(profile, data);
 */
export function tabs<T extends { tab: string }, I = void>(opts: TabsOptions<T, I>): ViewDefinition<T, void, I> {
    const disableActive = opts.disableActive ?? true;
    const on: NonNullable<ViewDefinition<T, void, I>["on"]> = { ...opts.on };
    for (const t of opts.tabs) {
        on[`tab:${t.key}`] = (c) => {
            c.state.tab = t.key;
            return opts.onTabChange?.(c.state, t.key);
        };
    }
    return defineView<T, void, I>({
        name: opts.name,
        initial: opts.initial,
        timeoutMs: opts.timeoutMs,
        render: (state, kit) => {
            const { payload, extraRows = [] } = opts.renderTab(state, kit);
            return {
                ...payload,
                components: [...(payload.components ?? []), ...tabRows(opts.tabs, state.tab, kit, disableActive), ...extraRows],
            };
        },
        on,
    });
}
