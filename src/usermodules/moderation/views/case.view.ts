import { ButtonStyle } from "discord.js";
import { defineView, type ViewDefinition } from "@/define";
import type { CaseService } from "../services/case.service";
import { type CaseEventRow, type CaseRow, ModerationError } from "../types";
import { caseDetailReply } from "./case.render";

export interface CaseViewState {
    row: CaseRow;
    events: CaseEventRow[];
}

export interface CaseViewDeps {
    guildId: string;
    row: CaseRow;
    service: Pick<CaseService, "unwarn">;
    /** Checked on every Revoke click; the viewer may have lost the right since the Case was opened. */
    canRevoke?(userId: string): Promise<boolean>;
    /** The Case and its events as they are now. */
    reload(): Promise<CaseViewState>;
}

const REASON_MAX = 1000;

/** `case <id>`: the Case and its history, with a Revoke button while it is an active warn. */
export function caseView(deps: CaseViewDeps): ViewDefinition<CaseViewState, void, void> {
    return defineView<CaseViewState, void, void>({
        name: "moderation.case",
        initial: async () => deps.reload(),
        access: "invoker",
        render: ({ row, events }, kit) => {
            const payload = caseDetailReply(row, events);
            if (row.kind !== "warn" || row.ended_at) return payload;
            const unwarn = kit.button("unwarn", (b) => b.setLabel("Revoke").setStyle(ButtonStyle.Danger));
            return { ...payload, components: [...payload.components, kit.row(unwarn)] };
        },
        on: {
            unwarn: async (c) => {
                // The modal must be the first answer to the click (no slow work before it), so the
                // permission is checked once it is submitted.
                const { id } = c.state.row;
                const values = await c.modal({
                    title: `Revoke ${id}`,
                    fields: [{ key: "reason", label: "Reason (optional)", required: false, maxLength: REASON_MAX }],
                });
                if (!values) return;
                if (deps.canRevoke && !(await deps.canRevoke(c.user.id))) {
                    await c.notify("You don't have permission to do that.");
                    return;
                }
                try {
                    await deps.service.unwarn({
                        guildId: deps.guildId,
                        caseId: id,
                        by: c.user.id,
                        reason: values.reason.trim() || undefined,
                    });
                } catch (err) {
                    if (!(err instanceof ModerationError)) throw err;
                    await c.notify(err.message);
                    return;
                }
                Object.assign(c.state, await deps.reload());
            },
        },
    });
}
