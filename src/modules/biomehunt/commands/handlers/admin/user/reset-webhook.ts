import { Logger } from "@/utils/logging";
import type { AdminCommandModule } from "../../../../types";
import * as userRepository from "@/modules/biomehunt/repository/User";

const logger = new Logger("biomehunt:reset-webhook");

const command: AdminCommandModule = {
    builder: sub =>
        sub.setDescription("Reset user's webhook configuration")
            .addUserOption(opt =>
                opt
                    .setName("user")
                    .setDescription("User to reset webhook")
                    .setRequired(true),
            ),

    execute: async interaction => {
        const user = interaction.options.getUser("user", true);

        const profile = await userRepository.getUserProfile(
            user.id,
            interaction.guildId!,
        );

        if (!profile) {
            await interaction.editReply("❌ User profile not found.");
            return;
        }

        // try to clear old webhook
        if (profile.webhookId) {
            try {
                const webhook = await interaction.client.fetchWebhook(profile.webhookId);
                await webhook.delete(`Webhook reset by admin (${interaction.user.tag})`,);
            } catch (error) {
                // ignore failures:
                // - webhook already deleted
                // - missing permissions
                // - invalid webhook id
                logger.warn(`Failed to delete webhook ${profile.webhookId} from user id ${profile.userId}:`, { error });
            }
        }

        await userRepository.updateUserProfile(user.id, interaction.guildId!, {
            webhookId: null,
            webhookUrl: null,
        });

        await interaction.editReply(
            `✅ Webhook reset for **${user.tag}**.`,
        );
    },
};

export default command;
