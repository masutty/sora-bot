import { MessageFlags } from "discord.js";
import { defineComponent } from "@/define";
import { CASUAL_VOTE_PREFIX, castCasualBallot } from "../services/casual-vote.service";
import { VoteChoice } from "../types";

/** Injected so tests never touch the DB - `casualVoteComponent()` (no args) wires the real service. */
export interface CasualVoteComponentDeps {
    castBallot: typeof castCasualBallot;
}

const NO_LONGER_AVAILABLE = "This vote is no longer available.";

/**
 * `biomehunt:casual-vote:<voteId>:<real|fake>` - Real/Fake on a regular forward. Everyone casts a
 * plain ballot (no admin shortcut: nothing is decided), and the card's live count follows. Defers
 * first, like the rare vote, so a slow DB never shows the click as failed.
 */
export function casualVoteComponent(deps: CasualVoteComponentDeps = { castBallot: castCasualBallot }) {
    return defineComponent({
        prefix: CASUAL_VOTE_PREFIX,
        handle: async (interaction, parts, client) => {
            if (!interaction.isButton()) return;
            await interaction.deferUpdate();

            const [voteId, choiceRaw] = parts;
            if (!voteId || (choiceRaw !== "real" && choiceRaw !== "fake")) {
                await interaction.followUp({ content: NO_LONGER_AVAILABLE, flags: MessageFlags.Ephemeral });
                return;
            }
            const choice = choiceRaw === "real" ? VoteChoice.REAL : VoteChoice.FAKE;

            const result = await deps.castBallot(client, voteId, interaction.user.id, choice);
            const reply = {
                not_found: NO_LONGER_AVAILABLE,
                finder: "You can't vote on your own find.",
                changed: `Vote changed to **${choice === VoteChoice.REAL ? "Real" : "Fake"}**. You can't change it again.`,
                unchanged: "You already voted.",
                change_locked: "You already changed your vote once - it can't change again.",
                ok: null,
            }[result.kind];
            if (reply) await interaction.followUp({ content: reply, flags: MessageFlags.Ephemeral });
        },
    });
}
