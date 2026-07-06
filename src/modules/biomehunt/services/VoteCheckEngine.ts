import { MessageFlags, PermissionFlagsBits } from "discord.js";
import type { Client, GuildMember, Interaction, Message } from "discord.js";
import { buildForwardContainer } from "./forwardRender";
import type { VoteCheckState } from "../types";

/**
 * In-memory only - doesn't need to survive a restart. Never cleaned up once created; the
 * admin-decision buttons stay usable (and overridable) for as long as this process is alive.
 */
const activeVotes = new Map<string, VoteCheckState>();

/**
 * Registers a rare-biome forward for admin confirm/deny - no public voting, just the buttons.
 * `originalJumpLink` must be the link to the message that actually triggered the forward
 * (the macro's webhook message), captured once here and reused on every future edit - never
 * recomputed from the forward message's own id, or it would end up linking to itself.
 */
export function startVoteCheck(
    sentMessage: Message,
    guildId: string,
    biome: string,
    roleId: string | null,
    serverLink: string | null,
    originalJumpLink: string,
): void {
    activeVotes.set(sentMessage.id, {
        messageId: sentMessage.id,
        guildId,
        channelId: sentMessage.channelId,
        biome,
        roleId,
        serverLink,
        originalJumpLink,
        status: "pending",
        decidedBy: null,
        decidedByUserId: null,
    });
}

/** Handles the Confirm/Deny buttons - admin-only, always overwrites whatever was decided before. */
export async function handleVoteButtonClick(_client: Client, interaction: Interaction): Promise<void> {
    if (!interaction.isButton()) return;
    if (interaction.customId !== "bh-vote-confirm" && interaction.customId !== "bh-vote-deny") return;

    const member = interaction.member as GuildMember | null;
    if (!member?.permissions.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: "Only administrators can do this.", ephemeral: true });
        return;
    }

    const state = activeVotes.get(interaction.message.id);
    if (!state) {
        await interaction.reply({ content: "This vote check is no longer available.", ephemeral: true });
        return;
    }

    state.status = interaction.customId === "bh-vote-confirm" ? "confirmed" : "denied";
    state.decidedBy = "admin";
    state.decidedByUserId = interaction.user.id;

    const container = buildForwardContainer({
        biome: state.biome,
        roleId: state.roleId,
        serverLink: state.serverLink,
        jumpLink: state.originalJumpLink,
        vote: { status: state.status, decidedBy: state.decidedBy, decidedByUserId: state.decidedByUserId },
    });

    await interaction.update({ components: [container], flags: MessageFlags.IsComponentsV2 });
}
