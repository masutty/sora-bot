import { ContainerBuilder, MessageFlags, SeparatorSpacingSize } from "discord.js";
import { tabs, type ViewDefinition } from "@/define";
import { unix } from "@/utils/format";
import type { QuotaDayReport, QuotaMember, QuotaRoleResult } from "../services/quota-report.service";

/** Per list (hit / missed) per role - keeps the whole card under Discord's text limit on big servers. */
const MAX_LISTED = 15;

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

/** The members of one group, quoted so they read as indented under its heading. */
function memberList(members: QuotaMember[], target: number | null): string {
    if (members.length === 0) return "> -# Nobody";
    const shown = members
        .slice(0, MAX_LISTED)
        .map((m) => `<@${m.discordUserId}> \`${formatHm(m.activeSeconds)}${target === null ? "" : ` / ${formatHm(target)}`}\``);
    const more = members.length > MAX_LISTED ? `\n> -# … +${members.length - MAX_LISTED} more` : "";
    return `> ${shown.join(" · ")}${more}`;
}

/**
 * One quota role: its role as a heading with the target under it, then the Hit and Missed (or, while
 * the day is still running, Not yet) groups - each a bold label with its count, members quoted below.
 */
function roleSection(result: QuotaRoleResult, inProgress: boolean): string {
    const { role, hit, missed } = result;
    const lines = [`### <@&${role.role_id}>`, `-# Target: \`${formatHm(role.quota_target_seconds)}\` per day`];
    if (role.quota_window_hours !== 24) {
        lines.push(`-# ⚠️ This role really counts the last ${role.quota_window_hours}h - this view only looks at the quota day.`);
    }
    // Same "- `emoji label`" + quoted body format as the forward's "?" card.
    lines.push(`- \`✅ Hit · ${hit.length}\``, memberList(hit, null));
    lines.push(`- \`${inProgress ? "⏳ Not yet" : "❌ Missed"} · ${missed.length}\``, memberList(missed, role.quota_target_seconds));
    return lines.join("\n");
}

/** One quota day's card: which window it covers, then per quota role who hit / missed its target. */
export function buildQuotaDayContainer(report: QuotaDayReport, label: string): ContainerBuilder {
    const container = new ContainerBuilder().setAccentColor(0x5865f2);
    // The window's last minute, so it reads "21:00 to 20:59" instead of ending on the next day's start.
    const displayEnd = unix(new Date(report.end.getTime() - 60_000));
    container.addTextDisplayComponents((td) =>
        td.setContent(`## Quotas · ${label}\n> -# from <t:${unix(report.start)}:f> to <t:${displayEnd}:f>`),
    );

    if (report.roles.length === 0) {
        addDivider(container);
        container.addTextDisplayComponents((td) =>
            td.setContent("-# No quota roles configured - create one with `/bh-admin quotas create`."),
        );
        return container;
    }

    for (const result of report.roles) {
        addDivider(container);
        container.addTextDisplayComponents((td) => td.setContent(roleSection(result, report.inProgress)));
    }
    return container;
}

export interface QuotaStatsInput {
    today: ContainerBuilder;
    yesterday: ContainerBuilder;
}

interface QuotaStatsState {
    tab: string;
    containers: QuotaStatsInput;
}

/** `/bh-stats quotas`: today's quota day, with a Yesterday tab - both containers built upfront. */
export const quotaStatsView: ViewDefinition<QuotaStatsState, void, QuotaStatsInput> = tabs<QuotaStatsState, QuotaStatsInput>({
    name: "biomehunt.stats-quotas",
    initial: (containers) => ({ tab: "today", containers }),
    disableActive: true,
    tabs: [
        { key: "yesterday", label: "< Yesterday" },
        { key: "today", label: "Today >" },
    ],
    renderTab: (state) => ({
        payload: { flags: MessageFlags.IsComponentsV2, components: [state.containers[state.tab as keyof QuotaStatsInput]] },
    }),
});
