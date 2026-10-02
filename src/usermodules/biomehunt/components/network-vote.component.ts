import { MessageFlags } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { defineComponent } from "@/define";
import { type CastNetworkBallotResult, castNetworkBallot, defaultNetworkVoteDeps } from "../services/network-vote.service";
import { VoteChoice } from "../types";
import { formatScoreboard, NETWORK_VOTE_PREFIX } from "../views/network-mirror.view";

/** Injected so tests never touch the DB - `networkVoteComponent()` wires the real service. */
export interface NetworkVoteComponentDeps {
    cast: (
        client: BotClient,
        postId: string,
        discordUserId: string,
        guildId: string,
        choice: VoteChoice,
    ) => Promise<CastNetworkBallotResult>;
}

export function defaultNetworkVoteComponentDeps(): NetworkVoteComponentDeps {
    return {
        cast: (client, postId, userId, guildId, choice) =>
            castNetworkBallot(postId, userId, guildId, choice, defaultNetworkVoteDeps(client)),
    };
}

function answer(result: CastNetworkBallotResult): string {
    switch (result.kind) {
        case "ok":
            return `Vote recorded!\n${formatScoreboard(result.scoreboard)}`;
        case "already_voted":
            return `You already voted on this find.\n${formatScoreboard(result.scoreboard)}`;
        case "finder":
            return "You can't vote on your own find.";
        case "banned":
            return "You can't vote in the Network.";
        case "not_member":
            return "This server is no longer in the Network.";
        case "closed":
            return "This vote is already closed.";
        case "not_found":
            return "This vote is no longer available.";
    }
}

/**
 * `biomehunt:net-vote:<postId>:<real|fake>` - the Network's Real/Fake on a Mirror. The ballot counts
 * for the server it was clicked in. Mirrors are only edited once (at close), so the clicker sees the
 * current scoreboard in a private reply instead. `deferReply` runs before any DB work (Discord's 3s window).
 */
export function networkVoteComponent(deps: NetworkVoteComponentDeps = defaultNetworkVoteComponentDeps()) {
    return defineComponent({
        prefix: NETWORK_VOTE_PREFIX,
        handle: async (interaction, parts, client) => {
            if (!interaction.isButton()) return;
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            const [postId, choiceRaw] = parts;
            const guildId = interaction.guildId;
            if (!postId || !guildId || (choiceRaw !== "real" && choiceRaw !== "fake")) {
                await interaction.editReply({ content: "This vote is no longer available." });
                return;
            }

            const choice = choiceRaw === "real" ? VoteChoice.REAL : VoteChoice.FAKE;
            const result = await deps.cast(client, postId, interaction.user.id, guildId, choice);
            await interaction.editReply({ content: answer(result) });
        },
    });
}
