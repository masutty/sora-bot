import { MessageFlags } from "discord.js";
import { defineComponent } from "@/define";
import { endPauseFromMember } from "../services/pause.service";
import { PAUSE_NOTICE_PREFIX } from "../views/pause-notice.view";

export interface PauseNoticeComponentDeps {
    endPause: typeof endPauseFromMember;
}

const REPLIES = {
    ended: "You are no longer paused.",
    not_owner: "This is not yours to resolve.",
    not_active: "This pause is no longer active.",
};

/** `biomehunt:pause-notice:<pauseId>` - `Resolved` on a Notice. Only the paused member can end that exact pause. */
export function pauseNoticeComponent(deps: PauseNoticeComponentDeps = { endPause: endPauseFromMember }) {
    return defineComponent({
        prefix: PAUSE_NOTICE_PREFIX,
        handle: async (interaction, parts) => {
            if (!interaction.isButton()) return;
            const pauseId = Number(parts[0]);
            const result = Number.isInteger(pauseId) ? await deps.endPause(pauseId, interaction.user.id) : "not_active";
            await interaction.reply({ content: REPLIES[result], flags: MessageFlags.Ephemeral });
        },
    });
}
