import { MessageFlags } from "discord.js";
import { defineComponent } from "@/define";
import { NO_PINGS } from "@/utils/format";
import { buildForwardInfoText, FORWARD_INFO_PREFIX, parseForwardInfoParts } from "../views/forward-post.view";

/**
 * `biomehunt:forward-info:<delayS|->:<foundAt|->:<1|0>` - the "?" button on a badged forward
 * (delayed and/or simulated). Everything it explains is encoded in the id, so it needs no DB and
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
