import { ActionRowBuilder, type ButtonBuilder, ButtonStyle, ContainerBuilder, MessageFlags, SeparatorSpacingSize } from "discord.js";
import {
    type CommandContext,
    defineView,
    paginationHandlers,
    paginationRow,
    type RenderKit,
    type ViewDefinition,
    type ViewPayload,
} from "@/define";
import { NO_PINGS } from "@/utils/format";
import { getBiomesByCategory } from "../constants/biomes.constants";
import { isFlagEnabled } from "../repository/flags.repository";
import {
    getLeaderboard,
    LEADERBOARD_PERIOD_DAYS,
    type LeaderboardMetric,
    type LeaderboardPeriod,
    type LeaderboardRow,
} from "../repository/leaderboard.repository";

export const LEADERBOARD_PER_PAGE = 10;

const METRICS: Array<{ key: LeaderboardMetric; label: string }> = [
    { key: "rares", label: "Rares" },
    { key: "hours", label: "Hours" },
    { key: "seeds", label: "Seeds" },
];

const PERIODS: Array<{ key: LeaderboardPeriod; label: string }> = [
    { key: "week", label: "Last 7 days" },
    { key: "month", label: "Last 30 days" },
    { key: "all", label: "All time" },
];

const MEDALS = ["🥇", "🥈", "🥉"];

/** What the View needs that would otherwise be a DB call, injected so tests never touch it. */
export interface LeaderboardDeps {
    /** The server's ranked members for a ranking and period (see `getLeaderboard`). */
    load(metric: LeaderboardMetric, period: LeaderboardPeriod): Promise<LeaderboardRow[]>;
}

export interface LeaderboardInput {
    /** Discord id of the member who opened it - the one the bottom line is about. */
    viewerId: string;
    /** The server's economy is on - the Seeds ranking is only offered then. */
    economy: boolean;
    /** The first ranking (Rares, last 7 days). */
    rows: LeaderboardRow[];
}

interface LeaderboardState extends LeaderboardInput {
    metric: LeaderboardMetric;
    period: LeaderboardPeriod;
    page: number;
}

/** Seconds as `14h 30m` - or `45m` under an hour. */
export function formatHoursMinutes(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatValue(metric: LeaderboardMetric, value: number): string {
    if (metric === "hours") return formatHoursMinutes(value);
    if (metric === "seeds") return `${value.toLocaleString("en-US")} 🌱`;
    return value.toLocaleString("en-US");
}

/** Number of pages for `count` ranked members (at least 1). */
export function leaderboardPageCount(count: number): number {
    return Math.max(1, Math.ceil(count / LEADERBOARD_PER_PAGE));
}

/** One page (0-based) of a ranking, with the viewer's own position at the bottom when they are ranked. */
export function buildLeaderboard(
    rows: LeaderboardRow[],
    metric: LeaderboardMetric,
    period: LeaderboardPeriod,
    page: number,
    viewerId: string,
): ContainerBuilder {
    const metricLabel = METRICS.find((m) => m.key === metric)?.label ?? "";
    const periodLabel = PERIODS.find((p) => p.key === period)?.label ?? "";
    const container = new ContainerBuilder().setAccentColor(0x5865f2);
    const divider = () => container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    container.addTextDisplayComponents((td) => td.setContent(`## Leaderboard\n${metricLabel} · ${periodLabel}`));
    divider();

    const start = page * LEADERBOARD_PER_PAGE;
    const lines = rows
        .slice(start, start + LEADERBOARD_PER_PAGE)
        .map((r, i) => `${MEDALS[start + i] ?? `\`#${start + i + 1}\``} <@${r.discordUserId}> · \`${formatValue(metric, r.value)}\``);
    container.addTextDisplayComponents((td) => td.setContent(lines.length > 0 ? lines.join("\n") : "Nobody yet."));

    const own = rows.findIndex((r) => r.discordUserId === viewerId);
    if (own >= 0) {
        divider();
        container.addTextDisplayComponents((td) => td.setContent(`You're #${own + 1} · \`${formatValue(metric, rows[own].value)}\``));
    }
    return container;
}

function metricRow(kit: RenderKit, state: LeaderboardState): ActionRowBuilder<ButtonBuilder> {
    const shown = METRICS.filter((m) => m.key !== "seeds" || state.economy);
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        shown.map((m) =>
            kit.button(`metric:${m.key}`, (b) =>
                b
                    .setLabel(m.label)
                    .setStyle(m.key === state.metric ? ButtonStyle.Primary : ButtonStyle.Secondary)
                    .setDisabled(m.key === state.metric),
            ),
        ),
    );
}

/** The server leaderboard: Rares / Hours / Seeds rankings over the last 7 days, the last 30 days or all time. */
export function leaderboardView(deps: LeaderboardDeps): ViewDefinition<LeaderboardState, void, LeaderboardInput> {
    /** Loads the new ranking and goes to its first page. A Seeds click with the economy off is ignored. */
    const switchTo = async (state: LeaderboardState, change: Partial<Pick<LeaderboardState, "metric" | "period">>) => {
        const metric = change.metric ?? state.metric;
        const period = change.period ?? state.period;
        if (metric === "seeds" && !state.economy) return;
        state.rows = await deps.load(metric, period);
        state.metric = metric;
        state.period = period;
        state.page = 0;
    };

    return defineView<LeaderboardState, void, LeaderboardInput>({
        name: "biomehunt.leaderboard",
        initial: (input) => ({ ...input, metric: "rares", period: "week", page: 0 }),
        render: (state, kit): ViewPayload => {
            const pages = leaderboardPageCount(state.rows.length);
            return {
                flags: MessageFlags.IsComponentsV2,
                allowedMentions: NO_PINGS,
                components: [
                    buildLeaderboard(state.rows, state.metric, state.period, state.page, state.viewerId),
                    metricRow(kit, state),
                    kit.row(
                        kit.stringSelect("period", (s) =>
                            s.addOptions(PERIODS.map((p) => ({ label: p.label, value: p.key, default: p.key === state.period }))),
                        ),
                    ),
                    ...(pages > 1 ? [paginationRow(kit, state.page, pages)] : []),
                ],
            };
        },
        on: {
            ...paginationHandlers<LeaderboardState>({ pages: (s) => leaderboardPageCount(s.rows.length) }),
            "metric:rares": (c) => switchTo(c.state, { metric: "rares" }),
            "metric:hours": (c) => switchTo(c.state, { metric: "hours" }),
            "metric:seeds": (c) => switchTo(c.state, { metric: "seeds" }),
            period: (c) => {
                const period = c.values[0] as LeaderboardPeriod;
                if (!(period in LEADERBOARD_PERIOD_DAYS)) return;
                return switchTo(c.state, { period });
            },
        },
    });
}

/** Opens the server leaderboard, on Rares over the last 7 days. Used by `/bh leaderboard`. */
export async function openLeaderboardView(ctx: CommandContext, guildId: string, viewerId: string): Promise<void> {
    const rareBiomes = getBiomesByCategory("rare");
    const deps: LeaderboardDeps = { load: (metric, period) => getLeaderboard(guildId, metric, period, rareBiomes) };
    const [economy, rows] = await Promise.all([isFlagEnabled(guildId, "EXPERIMENT_BIOME_ECONOMY"), deps.load("rares", "week")]);
    await ctx.open(leaderboardView(deps), { viewerId, economy, rows });
}
