import { MessageFlags } from "discord.js";
import { defineComponent } from "@/define";
import { NO_PINGS } from "@/utils/format";
import { buildForwardInfoText, FORWARD_INFO_PREFIX, parseForwardInfoParts } from "../views/forward-post.view";

/**
 * `biomehunt:forward-info:<0|1 delayed>:<0|1 simulated>` - the "?" button on a badged forward
 * (delayed and/or simulated). Both flags are encoded in the id, so it needs no DB and
 * keeps working on old messages.
 */
export function forwardInfoComponent() {
    return defineComponent({
        prefix: FORWARD_INFO_PREFIX,
        handle: async (interaction, parts) => {
            if (!interaction.isButton()) return;

            const badges = parseForwardInfoParts(parts);
            const content = badges ? buildForwardInfoText(badges) : "No details available for this forward.";
            await interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: NO_PINGS });
        },
    });
}
