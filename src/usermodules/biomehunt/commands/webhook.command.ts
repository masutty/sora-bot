import { SlashCommandBuilder } from "discord.js";
import { defineCommand, type GuildCommandContext } from "@/define";
import { CommandCategory } from "@/types";
import { EmbedFormatter } from "@/utils/format";
import { defaultWebhookDeps, getMemberWebhook, type WebhookDeps } from "../services/webhook.service";
import { BiomeHuntError } from "../types";
import { webhookPayload } from "../views/webhook.view";

/** The URL is a secret: slash answers ephemerally, prefix (which can't) sends it by DM. */
export async function runWebhook(ctx: GuildCommandContext, deps: WebhookDeps = defaultWebhookDeps(ctx.client)): Promise<void> {
    await ctx.defer({ ephemeral: true });
    const message = webhookPayload(await getMemberWebhook(ctx.guild.id, ctx.user.id, deps));

    if (ctx.mode === "slash") {
        await ctx.reply(message);
        return;
    }

    try {
        await ctx.user.send(message);
    } catch {
        throw new BiomeHuntError("I couldn't send you a DM. Enable direct messages from server members, or use `/webhook`.");
    }
    await ctx.reply(EmbedFormatter.success("Sent to your DMs."));
}

export default defineCommand({
    name: "webhook",
    description: "Get your macro channel's webhook.",
    category: CommandCategory.UTILITY,
    showOnHelp: true,
    guildOnly: true,
    options: new SlashCommandBuilder(),
    run: (ctx) => runWebhook(ctx),
});
