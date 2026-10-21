import type { GuildMember } from "discord.js";
import { MessageFlags, PermissionFlagsBits } from "discord.js";
import { config } from "@/config";
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
    ownerIds: () => readonly string[];
}

export function defaultBiomeVoteComponentDeps(): BiomeVoteComponentDeps {
    return { castBallot, adminDecide, ownerIds: () => config.bot.ownerIds };
}

const NO_LONGER_AVAILABLE = "This vote is no longer available.";

/**
 * `biomehunt:vote:<voteId>:<real|fake>` - a click from an admin (Administrator permission) or a bot
 * owner decides the vote immediately and closes it; anyone else casts a community ballot.
 *
 * `deferUpdate()` runs FIRST, before any DB/Discord work - Discord gives an interaction only 3s to
 * be acknowledged, and `castBallot`/`adminDecide` can take longer than that (a DB round-trip plus
 * a separate message fetch+edit). Deferring immediately means the click is never shown as "failed"
 * to the user regardless of how long the actual work takes; the vote message itself is updated
 * separately by the service (via `client`, not through this interaction). Any ephemeral text is
 * sent afterward with `followUp` (a deferred interaction can no longer `reply`).
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

            await interaction.deferUpdate();

            const [voteId, choiceRaw] = parts;
            if (!voteId || (choiceRaw !== "real" && choiceRaw !== "fake")) {
                await interaction.followUp({ content: NO_LONGER_AVAILABLE, flags: MessageFlags.Ephemeral });
                return;
            }
            const choice = choiceRaw === "real" ? VoteChoice.REAL : VoteChoice.FAKE;

            const member = interaction.member as GuildMember | null;
            const isAdmin = member?.permissions.has(PermissionFlagsBits.Administrator) ?? false;

            if (isAdmin || deps.ownerIds().includes(interaction.user.id)) {
                const result = await deps.adminDecide(client, voteId, interaction.user.id, choice);
                switch (result.kind) {
                    case "not_found":
                        await interaction.followUp({ content: NO_LONGER_AVAILABLE, flags: MessageFlags.Ephemeral });
                        return;
                    case "already_decided":
                        await interaction.followUp({ content: "This vote was already decided.", flags: MessageFlags.Ephemeral });
                        return;
                    case "ok":
                        return;
                }
                return;
            }

            const result = await deps.castBallot(client, voteId, interaction.user.id, choice);
            switch (result.kind) {
                case "not_found":
                    await interaction.followUp({ content: NO_LONGER_AVAILABLE, flags: MessageFlags.Ephemeral });
                    return;
                case "closed":
                    await interaction.followUp({ content: "This vote is already closed.", flags: MessageFlags.Ephemeral });
                    return;
                case "finder":
                    await interaction.followUp({ content: "You can't vote on your own find.", flags: MessageFlags.Ephemeral });
                    return;
                case "changed":
                    await interaction.followUp({
                        content: `Vote changed to **${choice === VoteChoice.REAL ? "Real" : "Fake"}**. You can't change it again.`,
                        flags: MessageFlags.Ephemeral,
                    });
                    return;
                case "unchanged":
                    await interaction.followUp({ content: "You already voted.", flags: MessageFlags.Ephemeral });
                    return;
                case "change_locked":
                    await interaction.followUp({
                        content: "You already changed your vote once - it can't change again.",
                        flags: MessageFlags.Ephemeral,
                    });
                    return;
                case "ok":
                    return;
            }
        },
    });
}
