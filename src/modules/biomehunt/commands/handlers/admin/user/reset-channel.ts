import type { AdminCommandModule } from "../../../../types";
import * as userRepository from "@/modules/biomehunt/repository/User";

const command: AdminCommandModule = {
    builder: sub =>
        sub
            .setDescription("Reset user's dedicated macro channel")
            .addUserOption(opt =>
                opt
                    .setName("user")
                    .setDescription("User to reset channel")
                    .setRequired(true),
            ),

    execute: async interaction => {
        await interaction.deferReply({ ephemeral: true });

        const user = interaction.options.getUser("user", true);

        const profile = await userRepository.getUserProfile(
            user.id,
            interaction.guildId!,
        );

        if (!profile) {
            await interaction.editReply("❌ User profile not found.");
            return;
        }

        await userRepository.updateUserProfile(user.id, interaction.guildId!, {
            dedicatedChannelId: "",
        });

        await interaction.editReply(
            `✅ Dedicated channel reset for **${user.tag}**.`,
        );
    },
};

export default command;
