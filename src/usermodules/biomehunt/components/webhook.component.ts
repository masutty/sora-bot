import { MessageFlags } from "discord.js";
import { defineComponent } from "@/define";
import { defaultWebhookDeps, regenerateWebhook, type WebhookDeps } from "../services/webhook.service";
import { BiomeHuntError } from "../types";
import { confirmRegenerationPayload, WEBHOOK_PREFIX, webhookErrorPayload, webhookPayload } from "../views/webhook.view";

const OLD_STILL_THERE = "I couldn't delete your old webhook. Ask the staff to remove it";

/**
 * `biomehunt:webhook:<userId>:<ask|confirm>` - Regenerate on a webhook message. Persistent, so it
 * keeps working on an old DM; the service refuses anyone but the channel's owner.
 */
export function webhookComponent(deps?: WebhookDeps) {
    return defineComponent({
        prefix: WEBHOOK_PREFIX,
        handle: async (interaction, parts, client) => {
            if (!interaction.isButton()) return;
            const userId = Number(parts[0]);
            if (!Number.isInteger(userId)) return;

            if (parts[1] !== "confirm") {
                const ask = confirmRegenerationPayload(userId);
                await interaction.reply({ ...ask, flags: ask.flags | MessageFlags.Ephemeral });
                return;
            }

            // Creating and deleting webhooks can outlast Discord's 3 s window.
            await interaction.deferUpdate();
            try {
                const webhook = await regenerateWebhook(userId, interaction.user.id, deps ?? defaultWebhookDeps(client));
                await interaction.editReply(webhookPayload(webhook, webhook.oldRemoved ? [] : [OLD_STILL_THERE]));
            } catch (err) {
                const expected = err instanceof BiomeHuntError;
                await interaction.editReply(webhookErrorPayload(expected ? err.message : "Something went wrong. Please try again."));
                if (!expected) throw err;
            }
        },
    });
}
