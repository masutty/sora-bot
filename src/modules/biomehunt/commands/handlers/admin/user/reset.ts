import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
} from "discord.js";

import type { AdminCommandModule } from "../../../../types";
import * as userRepository from "@/modules/biomehunt/repository/User";

const command: AdminCommandModule = {
    builder: sub =>
        sub
            .setDescription("Reset (delete) a user profile")
            .addUserOption(opt =>
                opt
                    .setName("user")
                    .setDescription("User to reset")
                    .setRequired(true),
            ),

    execute: async interaction => {
        const target = interaction.options.getUser("user", true);

        const profile = await userRepository.getUserProfile(
            target.id,
            interaction.guildId!,
        );

        if (!profile) {
            await interaction.editReply("❌ User profile not found.");
            return;
        }

        const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId("confirm_reset")
                .setLabel("Yes, reset")
                .setStyle(ButtonStyle.Danger),

            new ButtonBuilder()
                .setCustomId("cancel_reset")
                .setLabel("Cancel")
                .setStyle(ButtonStyle.Secondary),
        );

        await interaction.editReply({
            content: `⚠️ Are you sure you want to DELETE the profile of **${target.tag}**?\n\nThis action is irreversible.`,
            components: [confirmRow],
        });

        const msg = await interaction.fetchReply();

        try {
            const collected = await msg.awaitMessageComponent({
                componentType: ComponentType.Button,
                time: 15_000,
            });

            if (collected.customId === "cancel_reset") {
                await collected.update({
                    content: "❎ Action cancelled.",
                    components: [],
                });
                return;
            }

            await userRepository.deleteUserProfile(
                target.id,
                interaction.guildId!,
            );

            await collected.update({
                content: `✅ Profile of **${target.tag}** has been deleted.`,
                components: [],
            });
        } catch {
            await interaction.editReply({
                content: "⏳ No confirmation received. Action cancelled.",
                components: [],
            });
        }
    },
};

export default command;
