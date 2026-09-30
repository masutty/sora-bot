import { ActionRowBuilder, type ButtonBuilder, ButtonStyle, ContainerBuilder, MessageFlags, SeparatorSpacingSize } from "discord.js";
import { defineView, paginationHandlers, paginationRow, type ViewDefinition, type ViewPayload } from "@/define";
import { unix } from "@/utils/format";
import { hitCount, type QuotaDayReport, type QuotaMember } from "../services/quota-report.service";

/** Members per page - with a mention and a time each, far under Discord's 4000-character text limit. */
export const QUOTA_MEMBERS_PER_PAGE = 20;

export type QuotaDay = "today" | "yesterday";

function addDivider(container: ContainerBuilder): void {
    container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
}

/** "3h 12m" / "45m" / "0m" - minutes precision is enough for a quota. */
function formatHm(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h === 0) return `${m}m`;
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function quotaPageCount(report: QuotaDayReport): number {
    return Math.max(1, Math.ceil(report.members.length / QUOTA_MEMBERS_PER_PAGE));
}

/** One quoted line of members. */
function quoted(members: QuotaMember[]): string {
    return `> ${members.map((m) => `<@${m.discordUserId}> \`${formatHm(m.activeSeconds)}\``).join(" · ")}`;
}

/**
 * One page of the member list (most active first). The `── target ──` line sits right before the
 * first member under the target - so it shows on whichever page that member lands on (at its top
 * when the cut falls between two pages), and nowhere when everyone or nobody hit.
 */
function memberPage(members: QuotaMember[], hits: number, target: number, page: number): string {
    if (members.length === 0) return "> -# Nobody";
    const from = page * QUOTA_MEMBERS_PER_PAGE;
    const slice = members.slice(from, from + QUOTA_MEMBERS_PER_PAGE);
    const cut = hits - from; // index of the first miss within this page
    const cutLine = `-# ── target \`${formatHm(target)}\` ──`;
    if (hits === 0 || hits === members.length || cut < 0 || cut >= slice.length) return quoted(slice);

    const above = slice.slice(0, cut);
    const below = slice.slice(cut);
    return [...(above.length > 0 ? [quoted(above)] : []), cutLine, quoted(below)].join("\n");
}

/** One quota day's card, for one quota role and one page of its members. */
export function buildQuotaDayContainer(report: QuotaDayReport, label: string, roleIndex: number, page: number): ContainerBuilder {
    const container = new ContainerBuilder().setAccentColor(0x5865f2);
    // The window's last minute, so it reads "21:00 to 20:59" instead of ending on the next day's start.
    const displayEnd = unix(new Date(report.end.getTime() - 60_000));
    container.addTextDisplayComponents((td) =>
        td.setContent(`## Quotas · ${label}\n> -# from <t:${unix(report.start)}:f> to <t:${displayEnd}:f>`),
    );
    addDivider(container);

    const role = report.roles[roleIndex];
    if (!role) {
        container.addTextDisplayComponents((td) =>
            td.setContent("-# No quota roles configured - create one with `/bh-admin quotas create`."),
        );
        return container;
    }

    const target = role.quota_target_seconds;
    const hits = hitCount(report.members, target);
    const misses = report.members.length - hits;
    const missLabel = report.inProgress ? `⏳ ${misses} not yet` : `❌ ${misses} missed`;
    const lines = [`### <@&${role.role_id}>`, `-# Target: \`${formatHm(target)}\` per day · ✅ ${hits} hit · ${missLabel}`];
    if (role.quota_window_hours !== 24) {
        lines.push(`-# ⚠️ This role really counts the last ${role.quota_window_hours}h - this view only looks at the quota day.`);
    }
    lines.push(memberPage(report.members, hits, target, page));
    container.addTextDisplayComponents((td) => td.setContent(lines.join("\n")));
    return container;
}

export interface QuotaStatsInput {
    reports: Record<QuotaDay, QuotaDayReport>;
    /** Quota role id -> its name, for the role select (a select option can't render a mention). */
    roleNames: Record<string, string>;
}

interface QuotaStatsState extends QuotaStatsInput {
    day: QuotaDay;
    roleIndex: number;
    page: number;
}

const DAY_LABELS: Record<QuotaDay, string> = { yesterday: "Yesterday", today: "Today" };

/**
 * `/bh-stats quotas`: one quota role at a time (a select picks it when there's more than one), its
 * members as one paginated list, and `< Yesterday` / `Today >` to switch days. Both days are loaded
 * upfront; switching the day or the role goes back to page 1.
 */
export const quotaStatsView: ViewDefinition<QuotaStatsState, void, QuotaStatsInput> = defineView<QuotaStatsState, void, QuotaStatsInput>({
    name: "biomehunt.stats-quotas",
    initial: (input) => ({ ...input, day: "today", roleIndex: 0, page: 0 }),
    render: (state, kit): ViewPayload => {
        const report = state.reports[state.day];
        const pages = quotaPageCount(report);
        const rows: ActionRowBuilder<ButtonBuilder>[] = [];

        const roleRow =
            report.roles.length > 1
                ? [
                      kit.row(
                          kit.stringSelect("role", (s) =>
                              s.setPlaceholder("Quota role").addOptions(
                                  report.roles.slice(0, 25).map((r, i) => ({
                                      label: state.roleNames[r.role_id] ?? `Role ${r.role_id}`,
                                      value: String(i),
                                      default: i === state.roleIndex,
                                  })),
                              ),
                          ),
                      ),
                  ]
                : [];
        if (report.roles.length > 0 && pages > 1) rows.push(paginationRow(kit, state.page, pages));
        rows.push(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                kit.button("day:yesterday", (b) =>
                    b
                        .setLabel("< Yesterday")
                        .setStyle(state.day === "yesterday" ? ButtonStyle.Primary : ButtonStyle.Secondary)
                        .setDisabled(state.day === "yesterday"),
                ),
                kit.button("day:today", (b) =>
                    b
                        .setLabel("Today >")
                        .setStyle(state.day === "today" ? ButtonStyle.Primary : ButtonStyle.Secondary)
                        .setDisabled(state.day === "today"),
                ),
            ),
        );

        return {
            flags: MessageFlags.IsComponentsV2,
            components: [buildQuotaDayContainer(report, DAY_LABELS[state.day], state.roleIndex, state.page), ...roleRow, ...rows],
        };
    },
    on: {
        ...paginationHandlers<QuotaStatsState>({ pages: (s) => quotaPageCount(s.reports[s.day]) }),
        role: (c) => {
            c.state.roleIndex = Number(c.values[0]);
            c.state.page = 0;
        },
        "day:yesterday": (c) => {
            c.state.day = "yesterday";
            c.state.page = 0;
        },
        "day:today": (c) => {
            c.state.day = "today";
            c.state.page = 0;
        },
    },
});
