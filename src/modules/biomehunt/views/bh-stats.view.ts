import { type ContainerBuilder, MessageFlags } from "discord.js";
import { tabs, type ViewDefinition } from "@/define";
import type { ActivityStatus, UserRow } from "../types";
import { buildUserListContainer, USERS_PER_PAGE } from "./stats-builders";

// ─── Biomes ─────────────────────────────────────────────────────────────────

type BiomesTab = "overview" | "contributors";

export interface BiomesStatsInput {
    overview: ContainerBuilder;
    contributors: ContainerBuilder;
}

interface BiomesStatsState {
    tab: string;
    containers: BiomesStatsInput;
}

/** Guild-wide biome stats: Overview / Top Contributors tabs over two already-built containers. */
export const biomesStatsView: ViewDefinition<BiomesStatsState, void, BiomesStatsInput> = tabs<BiomesStatsState, BiomesStatsInput>({
    name: "biomehunt.stats-biomes",
    initial: (containers) => ({ tab: "overview", containers }),
    tabs: [
        { key: "overview", label: "Overview" },
        { key: "contributors", label: "Top Contributors" },
    ],
    renderTab: (state) => ({
        payload: { flags: MessageFlags.IsComponentsV2, components: [state.containers[state.tab as BiomesTab]] },
    }),
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
export const sessionsStatsView: ViewDefinition<SessionsStatsState, void, SessionsStatsInput> = tabs<SessionsStatsState, SessionsStatsInput>({
    name: "biomehunt.stats-sessions",
    initial: (containers) => ({ tab: "overview", containers }),
    tabs: [
        { key: "overview", label: "Overview" },
        { key: "longest", label: "🏆 Longest Sessions" },
    ],
    renderTab: (state) => ({
        payload: { flags: MessageFlags.IsComponentsV2, components: [state.containers[state.tab as SessionsTab]] },
    }),
});

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

function pagesFor(state: UsersStatsState): number {
    const users = state.data.usersByStatus[state.tab as ActivityStatus];
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
        const pages = pagesFor(state);
        const extraRows = pages > 1
            ? [kit.row(
                kit.button("prev", (b) => b.setEmoji("⬅️")),
                kit.button("next", (b) => b.setEmoji("➡️")),
            )]
            : [];
        return { payload: { flags: MessageFlags.IsComponentsV2, components: [container] }, extraRows };
    },
    on: {
        prev: (c) => {
            const pages = pagesFor(c.state);
            c.state.page = c.state.page > 0 ? c.state.page - 1 : pages - 1;
        },
        next: (c) => {
            const pages = pagesFor(c.state);
            c.state.page = c.state.page < pages - 1 ? c.state.page + 1 : 0;
        },
    },
    onTabChange: (s) => {
        s.page = 0;
    },
});
