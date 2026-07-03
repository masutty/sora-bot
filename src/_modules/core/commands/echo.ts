import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";

export default defineCommand({
	name: "echo",
	description: "Repeats a message!",
	category: CommandCategory.GENERAL,
    options: new SlashCommandBuilder()
        .addStringOption((opt) =>
            opt
                .setName("message")
                .setDescription("Text to be repeated")
                .setRequired(true)
                .setMaxLength(1000),
        ),

	async execute(ctx) {
		const text = ctx.args.getString("message");
		if (!text) {
			await ctx.reply({
				content: "❌ You need to tell me something to repeat!",
			});
			return;
		}
		await ctx.reply({
			embeds: [
				new EmbedBuilder().setColor(0x57f287).setDescription(`💬 ${text}`),
			],
		});
	},
});
