import type { GuildMember } from "discord.js";
import { PermissionFlagsBits } from "discord.js";
import { defineComponent } from "@/define";
import { adminDecide, castBallot } from "../services/biome-vote.service";
import { VoteChoice } from "../types";

/**
 * Everything the vote buttons need that would otherwise be a service call, injected so tests never
 * touch the DB - `biomeVoteComponent()` (no args) wires the real service functions.
 */
export interface BiomeVoteComponentDeps {
    castBallot: typeof castBallot;
    adminDecide: typeof adminDecide;
}

export function defaultBiomeVoteComponentDeps(): BiomeVoteComponentDeps {
    return { castBallot, adminDecide };
}

const NO_LONGER_AVAILABLE = "This vote is no longer available.";

/**
 * `biomehunt:vote:<voteId>:<real|fake>` - a click from an admin (Administrator permission) decides
 * the vote immediately and closes it; anyone else casts a community ballot. Both paths edit the
 * forward message themselves (via the service, using `client`); this handler only ever replies
 * ephemerally, for errors, or acknowledges the update.
 *
 * `legacyIds` are the old bare `bh-vote-confirm`/`bh-vote-deny` customIds (matched by the router's
 * exact-equality legacyIds rule, never as a prefix) - they land here with `parts = []`, same as any
 * other malformed/unparseable parts, and always just answer `NO_LONGER_AVAILABLE`.
 */
export function biomeVoteComponent(deps: BiomeVoteComponentDeps = defaultBiomeVoteComponentDeps()) {
    return defineComponent({
        prefix: "biomehunt:vote",
        legacyIds: ["bh-vote-confirm", "bh-vote-deny"],
        handle: async (interaction, parts, client) => {
            if (!interaction.isButton()) return;

            const [voteId, choiceRaw] = parts;
            if (!voteId || (choiceRaw !== "real" && choiceRaw !== "fake")) {
                await interaction.reply({ content: NO_LONGER_AVAILABLE, ephemeral: true });
                return;
            }
            const choice = choiceRaw === "real" ? VoteChoice.REAL : VoteChoice.FAKE;

            const member = interaction.member as GuildMember | null;
            const isAdmin = member?.permissions.has(PermissionFlagsBits.Administrator) ?? false;

            if (isAdmin) {
                const result = await deps.adminDecide(client, voteId, interaction.user.id, choice);
                switch (result.kind) {
                    case "not_found":
                        await interaction.reply({ content: NO_LONGER_AVAILABLE, ephemeral: true });
                        return;
                    case "already_decided":
                        await interaction.reply({ content: "This vote was already decided.", ephemeral: true });
                        return;
                    case "ok":
                        await interaction.deferUpdate();
                        return;
                }
                return;
            }

            const result = await deps.castBallot(client, voteId, interaction.user.id, choice);
            switch (result.kind) {
                case "not_found":
                    await interaction.reply({ content: NO_LONGER_AVAILABLE, ephemeral: true });
                    return;
                case "closed":
                    await interaction.reply({ content: "This vote is already closed.", ephemeral: true });
                    return;
                case "finder":
                    await interaction.reply({ content: "You can't vote on your own find.", ephemeral: true });
                    return;
                case "already_voted":
                    await interaction.reply({ content: "You already voted.", ephemeral: true });
                    return;
                case "ok":
                    await interaction.deferUpdate();
                    return;
            }
        },
    });
}
