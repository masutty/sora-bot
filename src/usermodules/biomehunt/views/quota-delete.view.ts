import { ContainerBuilder, MessageFlags } from "discord.js";
import { defineView, type ViewDefinition, type ViewRender } from "@/define";
import { EmbedFormatter, NO_PINGS } from "@/utils/format";
import { settings } from "../settings";
import type { QuotaRoleRow } from "../types";

/** Everything the View needs that would otherwise be a DB call, injected so its tests never hit it
 * - `bh-admin.command.ts` wires the real repository/service functions. */
export interface QuotaDeleteDeps {
    getQuotaRoles(guildId: string): Promise<QuotaRoleRow[]>;
    removeQuotaRole(guildId: string, roleId: string): Promise<string>;
}

export interface QuotaDeleteInput {
    guildId: string;
}

interface QuotaDeleteState {
    guildId: string;
    roles: QuotaRoleRow[];
    /** Set once the flow has an outcome to show instead of the numbered list - success after a
     * removal, or "no roles" up front. Either way the view is done showing it. */
    result?: { success: boolean; text: string };
}

function formatQuotaRoleLine(r: QuotaRoleRow): string {
    const modeLabel = r.mode === "F" ? "Fixed" : "Rolling Window";
    const durationNote = r.mode === "F" ? `, ${r.access_duration_days}d access` : "";
    return `<@&${r.role_id}> - ${modeLabel}: ${r.quota_target_seconds / 3600}h / ${r.quota_window_hours}h window${durationNote}`;
}

/**
 * `bh-admin quotas delete` without a `role` - numbered list, type the number to remove
 * (`acceptText`/`onText`, retrying on an invalid one via `c.notify`, same shape as
 * `forward-remove.view.ts`). A ROOT view (opened directly from the command, not a child of a
 * bigger list): its own idle timeout, `settings.ui.quotaReplyTimeoutMs`, and its own expiry
 * screen, "Timed out, nothing removed." No roles configured -> shows that and ends immediately,
 * no prompt.
 */
export function quotaDeleteView(deps: QuotaDeleteDeps): ViewDefinition<QuotaDeleteState, void, QuotaDeleteInput> {
    return defineView<QuotaDeleteState, void, QuotaDeleteInput>({
        name: "biomehunt.quota-delete",
        initial: async (input) => ({ guildId: input.guildId, roles: await deps.getQuotaRoles(input.guildId) }),
        timeoutMs: settings.ui.quotaReplyTimeoutMs,
        start: (c) => {
            if (c.state.roles.length === 0) {
                c.state.result = { success: false, text: "No quota roles configured yet." };
                c.done();
            }
        },
        render: (state): ViewRender => {
            if (state.result) {
                const formatted = state.result.success ? EmbedFormatter.success(state.result.text) : EmbedFormatter.info(state.result.text);
                return { ...formatted, allowedMentions: NO_PINGS };
            }

            const lines = state.roles.map((r, i) => `${i + 1}. ${formatQuotaRoleLine(r)}`);
            const container = new ContainerBuilder().setAccentColor(0x5865f2);
            container.addTextDisplayComponents((td) =>
                td.setContent(`**Delete Quota Role**\nType the number of the quota role you want to delete:\n\n${lines.join("\n")}`),
            );

            return {
                flags: MessageFlags.IsComponentsV2,
                acceptText: true,
                components: [container],
                allowedMentions: NO_PINGS,
            };
        },
        onText: async (c) => {
            const n = Number(c.text.trim());
            if (!Number.isInteger(n) || n < 1 || n > c.state.roles.length) {
                await c.notify(`Please type a number between 1 and ${c.state.roles.length}.`);
                return;
            }
            const target = c.state.roles[n - 1];
            const message = await deps.removeQuotaRole(c.state.guildId, target.role_id);
            c.state.result = { success: true, text: message };
            c.done();
        },
        onExpire: () => EmbedFormatter.info("Timed out, nothing removed."),
    });
}
