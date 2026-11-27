import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, MessageFlags } from "discord.js";
import { formatCodeblock, NO_PINGS, unix } from "@/utils/format";
import type { MemberWebhook } from "../services/webhook.service";

export const WEBHOOK_PREFIX = "biomehunt:webhook";

const ACCENT = 0x5865f2;
const WARNING = 0xf0b232;

function payload(container: ContainerBuilder) {
    return { flags: MessageFlags.IsComponentsV2 as const, components: [container], allowedMentions: NO_PINGS };
}

function regenerateRow(userId: number, step: "ask" | "confirm", disabled: boolean) {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`${WEBHOOK_PREFIX}:${userId}:${step}`)
            .setLabel("Regenerate")
            .setStyle(step === "confirm" ? ButtonStyle.Danger : ButtonStyle.Secondary)
            .setDisabled(disabled),
    );
}

/** The member's webhook, with the Regenerate button (disabled while the cooldown runs). */
export function webhookPayload(webhook: MemberWebhook, notes: string[] = []) {
    const next = webhook.nextRegenerationAt;
    const lines = [
        "### Your webhook",
        `<#${webhook.channelId}>`,
        formatCodeblock(webhook.url, ""),
        "- Never share this URL, and only use it in your macro",
        ...(next ? [`- You can regenerate it again <t:${unix(next)}:R>`] : []),
        ...notes.map((note) => `- ${note}`),
    ];
    return payload(
        new ContainerBuilder()
            .setAccentColor(ACCENT)
            .addTextDisplayComponents((td) => td.setContent(lines.join("\n")))
            .addActionRowComponents(regenerateRow(webhook.userId, "ask", next !== null)),
    );
}

export function confirmRegenerationPayload(userId: number) {
    return payload(
        new ContainerBuilder()
            .setAccentColor(WARNING)
            .addTextDisplayComponents((td) =>
                td.setContent(
                    [
                        "### Regenerate your webhook?",
                        "- Your current URL stops working",
                        "- Your macro only works again after you paste the new URL in it",
                        "- You can do this once every 24 hours",
                    ].join("\n"),
                ),
            )
            .addActionRowComponents(regenerateRow(userId, "confirm", false)),
    );
}

export function webhookErrorPayload(message: string) {
    return payload(new ContainerBuilder().setAccentColor(0xda373c).addTextDisplayComponents((td) => td.setContent(message)));
}
