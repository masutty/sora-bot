import { MessageFlags, PermissionFlagsBits } from "discord.js";
import { config } from "@/config";
import type { BotClient } from "@/core/bot-client";
import { defineComponent } from "@/define";
import {
    type CastNetworkBallotResult,
    castNetworkBallot,
    decideNetworkVote,
    defaultNetworkVoteDeps,
} from "../services/network-vote.service";
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
        canVoteOnOwnFind: boolean,
    ) => Promise<CastNetworkBallotResult>;
    decide: (client: BotClient, postId: string, ownerId: string, choice: VoteChoice) => Promise<"ok" | "already_closed" | "not_found">;
    ownerIds: () => readonly string[];
}

export function defaultNetworkVoteComponentDeps(): NetworkVoteComponentDeps {
    return {
        cast: (client, postId, userId, guildId, choice, canVoteOnOwnFind) =>
            castNetworkBallot(postId, userId, guildId, choice, canVoteOnOwnFind, defaultNetworkVoteDeps(client)),
        decide: (client, postId, ownerId, choice) => decideNetworkVote(postId, ownerId, choice, defaultNetworkVoteDeps(client)),
        ownerIds: () => config.bot.ownerIds,
    };
}

const CHOICE_LABEL: Record<VoteChoice, string> = { [VoteChoice.REAL]: "Real", [VoteChoice.FAKE]: "Fake" };

function answer(result: CastNetworkBallotResult, choice: VoteChoice): string {
    switch (result.kind) {
        case "ok":
            return `Vote recorded!
${formatScoreboard(result.scoreboard)}`;
        case "changed":
            return `Vote changed to **${CHOICE_LABEL[choice]}**. You can't change it again.
${formatScoreboard(result.scoreboard)}`;
        case "unchanged":
            return `You already voted **${CHOICE_LABEL[choice]}** on this find.
${formatScoreboard(result.scoreboard)}`;
        case "change_locked":
            return `You already changed your vote once - it can't change again.
${formatScoreboard(result.scoreboard)}`;
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

const DECIDE_ANSWER: Record<"ok" | "already_closed" | "not_found", (choice: VoteChoice) => string> = {
    ok: (choice) => `Vote decided: marked as **${CHOICE_LABEL[choice]}**.`,
    already_closed: () => "This vote is already closed.",
    not_found: () => "This vote is no longer available.",
};

/**
 * `biomehunt:net-vote:<postId>:<real|fake>` - the Network's Real/Fake on a Mirror. A bot owner's click
 * decides the vote on the spot; anyone else's is one ballot (an admin or owner of the server they
 * click in may vote on their own find). Mirrors are only edited once (at close), so the clicker sees
 * the current scoreboard in a private reply instead. `deferReply` runs before any DB work (Discord's 3s window).
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
            if (deps.ownerIds().includes(interaction.user.id)) {
                const result = await deps.decide(client, postId, interaction.user.id, choice);
                await interaction.editReply({ content: DECIDE_ANSWER[result](choice) });
                return;
            }

            // A server's owner always has Administrator in the interaction's computed permissions.
            const canVoteOnOwnFind = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;
            const result = await deps.cast(client, postId, interaction.user.id, guildId, choice, canVoteOnOwnFind);
            await interaction.editReply({ content: answer(result, choice) });
        },
    });
}
