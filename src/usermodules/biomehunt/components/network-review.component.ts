import { type ContainerBuilder, MessageFlags } from "discord.js";
import { config } from "@/config";
import type { BotClient } from "@/core/bot-client";
import { defineComponent } from "@/define";
import { getNetworkGuild } from "../repository/network.repository";
import { loadEligibility } from "../services/network-eligibility.service";
import { type DecideResult, decideJoinRequest, defaultMembershipDeps } from "../services/network-membership.service";
import { buildJoinRequestContainer, NETWORK_REVIEW_PREFIX } from "../views/network.view";

/** Injected so tests never touch the DB - `defaultNetworkReviewDeps` wires the real service. */
export interface NetworkReviewComponentDeps {
    ownerIds: () => readonly string[];
    decide: (client: BotClient, guildId: string, ownerId: string, approve: boolean) => Promise<DecideResult>;
    /** The request card again, with the buttons replaced by who decided. */
    renderDecided: (client: BotClient, guildId: string, approved: boolean, ownerId: string) => Promise<ContainerBuilder>;
}

export function defaultNetworkReviewDeps(): NetworkReviewComponentDeps {
    return {
        ownerIds: () => config.bot.ownerIds,
        decide: (client, guildId, ownerId, approve) => decideJoinRequest(guildId, ownerId, approve, defaultMembershipDeps(client)),
        renderDecided: async (client, guildId, approved, ownerId) => {
            const [{ card }, row] = await Promise.all([loadEligibility(guildId), getNetworkGuild(guildId)]);
            const guildName = client.guilds.cache.get(guildId)?.name ?? guildId;
            return buildJoinRequestContainer({
                guildId,
                guildName,
                inviteUrl: row?.invite_url,
                card,
                decided: { approved, byUserId: ownerId },
            });
        },
    };
}

/**
 * `biomehunt:network-review:<guildId>:<approve|reject>` - the buttons on a join request DM. Only a
 * bot owner may decide. `deferUpdate()` runs before any DB work (Discord's 3s window), same as
 * `biome-vote.component.ts`.
 */
export function networkReviewComponent(deps: NetworkReviewComponentDeps = defaultNetworkReviewDeps()) {
    return defineComponent({
        prefix: NETWORK_REVIEW_PREFIX,
        handle: async (interaction, parts, client) => {
            if (!interaction.isButton()) return;
            if (!deps.ownerIds().includes(interaction.user.id)) {
                await interaction.reply({ content: "Only the bot owner can decide Network requests.", flags: MessageFlags.Ephemeral });
                return;
            }

            await interaction.deferUpdate();
            const [guildId, action] = parts;
            if (!guildId || (action !== "approve" && action !== "reject")) {
                await interaction.followUp({ content: "This request is no longer available.", flags: MessageFlags.Ephemeral });
                return;
            }

            const approved = action === "approve";
            const result = await deps.decide(client, guildId, interaction.user.id, approved);
            if (result === "not_pending") {
                await interaction.followUp({ content: "This request is no longer pending.", flags: MessageFlags.Ephemeral });
                return;
            }
            const admitted = approved && result === "ok";
            await interaction.editReply({ components: [await deps.renderDecided(client, guildId, admitted, interaction.user.id)] });
            if (result === "banned") {
                await interaction.followUp({
                    content: "This server is banned from the Network - its request was rejected.",
                    flags: MessageFlags.Ephemeral,
                });
            }
        },
    });
}
