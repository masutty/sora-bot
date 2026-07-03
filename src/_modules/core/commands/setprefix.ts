import { PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import {
	invalidatePrefixCache,
	updateGuildPrefix,
} from "../../../database/guildRepository";

export default defineCommand({
	name: "setprefix",
	description: "Defines my prefix on this server!",
	category: CommandCategory.UTILITY,
	adminOnly: true,
	options: new SlashCommandBuilder()
		.setName("setprefix")
		.setDescription("Defines my prefix for this server!.")
		.addStringOption((opt) =>
			opt
				.setName("prefix")
				.setDescription("New prefix")
				.setRequired(true)
				.setMaxLength(5),
		)
		.setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

	async execute(ctx) {
		if (!ctx.guild) {
			await ctx.reply({ content: "Only in servers!", ephemeral: true });
			return;
		}

		const newPrefix = ctx.args.getString("prefix")?.trim();
		if (!newPrefix || !/^[^\s]{1,5}$/.test(newPrefix)) {
			await ctx.reply({
				content: "❌ Invalid prefix (1-5 characters, no spaces).",
				ephemeral: true,
			});
			return;
		}

		await updateGuildPrefix(ctx.guild.id, newPrefix);
		invalidatePrefixCache(ctx.guild.id);
		await ctx.reply({ content: `✅ Prefix updated to \`${newPrefix}\`` });
	},
});
