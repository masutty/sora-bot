import { MessageFlags } from "discord.js";
import { defineComponent } from "@/define";
import { NO_PINGS } from "@/utils/format";
import { buildForwardInfoContainer, FORWARD_INFO_PREFIX, parseForwardInfoParts } from "../views/forward-post.view";

/**
 * `biomehunt:forward-info:<0|1 delayed>:<0|1 simulated>[:<network>[:<home>[:<vote id>]]]` - the "?" button on a forward (or
 * Network Mirror): the badge explanations plus the vote id. Everything is encoded in the id, so it
 * needs no DB and keeps working on old messages.
 */
export function forwardInfoComponent() {
    return defineComponent({
        prefix: FORWARD_INFO_PREFIX,
        handle: async (interaction, parts) => {
            if (!interaction.isButton()) return;

            const info = parseForwardInfoParts(parts);
            if (!info) {
                await interaction.reply({ content: "No details available for this forward.", flags: MessageFlags.Ephemeral });
                return;
            }
            await interaction.reply({
                components: [buildForwardInfoContainer(info.badges, info.voteId)],
                flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
                allowedMentions: NO_PINGS,
            });
        },
    });
}
