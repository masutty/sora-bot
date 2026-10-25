import { type ContainerBuilder, MessageFlags } from "discord.js";
import { paginationHandlers, tabs, type ViewDefinition } from "@/define";
import type { RarePeriod, RareStatsData } from "../services/rare-stats.service";
import type { ActivityStatus, UserRow } from "../types";
import { ALL_RARE_BIOMES, buildRareSection, type RareSection, rareControlRows, rarePageCount } from "./rare-stats.view";
import { buildUserListContainer, USERS_PER_PAGE } from "./stats-builders";

// ─── Biomes ─────────────────────────────────────────────────────────────────

type BiomesTab = "overview" | "contributors";

export interface BiomesStatsInput {
    overview: ContainerBuilder;
    contributors: ContainerBuilder;
    rares: RareStatsData;
}

interface BiomesStatsState {
    tab: string;
    containers: Omit<BiomesStatsInput, "rares">;
    rares: RareStatsData;
    section: RareSection;
    period: RarePeriod;
    /** Members' or History's page (0-based). */
    page: number;
    /** History's biome filter - `null` for every rare biome. */
    biome: string | null;
}

/** Guild-wide biome stats: Overview / Top Contributors over two already-built containers, and Rares, built from its data on each render. */
export const biomesStatsView: ViewDefinition<BiomesStatsState, void, BiomesStatsInput> = tabs<BiomesStatsState, BiomesStatsInput>({
    name: "biomehunt.stats-biomes",
    initial: ({ rares, ...containers }) => ({
        tab: "overview",
        containers,
        rares,
        section: "overview",
        period: "all",
        page: 0,
        biome: null,
    }),
    disableActive: false,
    tabs: [
        { key: "overview", label: "Overview" },
        { key: "contributors", label: "Top Contributors" },
        { key: "rares", label: "Rares" },
    ],
    renderTab: (state, kit) => {
        if (state.tab !== "rares")
            return { payload: { flags: MessageFlags.IsComponentsV2, components: [state.containers[state.tab as BiomesTab]] } };
        return {
            payload: {
                flags: MessageFlags.IsComponentsV2,
                components: [
                    buildRareSection(state.rares, state.section, state.period, state.page, state.biome),
                    ...rareControlRows(kit, state.rares, state.section, state.period, state.page, state.biome),
                ],
            },
        };
    },
    on: {
        ...paginationHandlers<BiomesStatsState>({ pages: (s) => rarePageCount(s.rares, s.section, s.period, s.biome) }),
        "rare-section": (c) => {
            c.state.section = c.values[0] as RareSection;
            c.state.page = 0;
        },
        "rare-period": (c) => {
            c.state.period = c.values[0] as RarePeriod;
            c.state.page = 0;
        },
        "rare-biome": (c) => {
            const value = c.values[0];
            c.state.biome = !value || value === ALL_RARE_BIOMES ? null : value;
            c.state.page = 0;
        },
    },
});

// ─── Sessions ───────────────────────────────────────────────────────────────

type SessionsTab = "overview" | "longest";

export interface SessionsStatsInput {
    overview: ContainerBuilder;
    longest: ContainerBuilder;
}

interface SessionsStatsState {
    tab: string;
    containers: SessionsStatsInput;
}

/** Guild-wide session stats: Overview / Longest Sessions tabs over two already-built containers. */
export const sessionsStatsView: ViewDefinition<SessionsStatsState, void, SessionsStatsInput> = tabs<SessionsStatsState, SessionsStatsInput>(
    {
        name: "biomehunt.stats-sessions",
        initial: (containers) => ({ tab: "overview", containers }),
        disableActive: false,
        tabs: [
            { key: "overview", label: "Overview" },
            { key: "longest", label: "🏆 Longest Sessions" },
        ],
        renderTab: (state) => ({
            payload: { flags: MessageFlags.IsComponentsV2, components: [state.containers[state.tab as SessionsTab]] },
        }),
    },
);

// ─── Users ──────────────────────────────────────────────────────────────────

const STATUS_BUTTON_LABELS: Record<ActivityStatus, string> = { active: "🟢 Active", idle: "🟡 Idle", inactive: "🔴 Inactive" };
const USER_STATUS_ORDER: ActivityStatus[] = ["active", "idle", "inactive"];

export interface UsersStatsInput {
    overview: ContainerBuilder;
    usersByStatus: Record<ActivityStatus, UserRow[]>;
}

interface UsersStatsState {
    tab: string;
    page: number;
    data: UsersStatsInput;
}

/** `null` when the current tab has no page concept (the Overview tab, or a stale click that
 * landed after the tab already switched away from a status) - callers must no-op on `null`. */
function pagesFor(state: UsersStatsState): number | null {
    const users = state.data.usersByStatus[state.tab as ActivityStatus] as UserRow[] | undefined;
    if (!users) return null;
    return Math.max(Math.ceil(users.length / USERS_PER_PAGE), 1);
}

/**
 * Guild members by activity status: an Overview tab, then one per status (Active/Idle/Inactive)
 * with its own paginated user list - prev/next WRAP AROUND (first page's `<` goes to the last, and
 * vice versa), same as the old `runUsersStats`.
 */
export const usersStatsView: ViewDefinition<UsersStatsState, void, UsersStatsInput> = tabs<UsersStatsState, UsersStatsInput>({
    name: "biomehunt.stats-users",
    initial: (data) => ({ tab: "overview", page: 0, data }),
    disableActive: false,
    tabs: [
        { key: "overview", label: "Overview" },
        ...USER_STATUS_ORDER.map((status) => ({ key: status, label: STATUS_BUTTON_LABELS[status] })),
    ],
    renderTab: (state, kit) => {
        if (state.tab === "overview") {
            return { payload: { flags: MessageFlags.IsComponentsV2, components: [state.data.overview] } };
        }
        const status = state.tab as ActivityStatus;
        const users = state.data.usersByStatus[status];
        const container = buildUserListContainer(users, state.page, status);
        const pages = pagesFor(state) ?? 1;
        const extraRows =
            pages > 1
                ? [
                      kit.row(
                          kit.button("prev", (b) => b.setEmoji("⬅️")),
                          kit.button("next", (b) => b.setEmoji("➡️")),
                      ),
                  ]
                : [];
        return { payload: { flags: MessageFlags.IsComponentsV2, components: [container] }, extraRows };
    },
    on: {
        // A stale/racing click (the user switched to Overview - no pages there - between the
        // render and this click landing): no-op instead of throwing on the missing status entry.
        prev: (c) => {
            const pages = pagesFor(c.state);
            if (pages === null) return;
            c.state.page = c.state.page > 0 ? c.state.page - 1 : pages - 1;
        },
        next: (c) => {
            const pages = pagesFor(c.state);
            if (pages === null) return;
            c.state.page = c.state.page < pages - 1 ? c.state.page + 1 : 0;
        },
    },
    onTabChange: (s) => {
        s.page = 0;
    },
});
