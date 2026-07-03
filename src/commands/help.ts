import { EmbedBuilder } from "discord.js";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import { config } from "../config";
import { getGuildPrefix } from "../database/guildRepository";

export default defineCommand({
	name: "help",
	description: "Lists all available commands",
	category: CommandCategory.UTILITY,
	args: [
		{
			name: "command",
			type: "string",
			required: false,
			description: "Command name to check details",
		},
	],

	async execute(ctx) {
		const cmdName = ctx.args.getString("command");
		const prefix = ctx.guild
			? await getGuildPrefix(ctx.guild.id)
			: config.bot.defaultPrefix;

		if (cmdName) {
			const cmd = ctx.client.commands.get(cmdName.toLowerCase());
			if (!cmd) {
				await ctx.reply({ content: `Command \`${cmdName}\` not found.` });
				return;
			}

			const embed = new EmbedBuilder()
				.setColor(0x5865f2)
				.setTitle(`/${cmd.name}`)
				.setDescription(cmd.description);

			if (cmd.args?.length) {
				embed.addFields({
					name: "Arguments",
					value: cmd.args
						.map(
							(a) =>
								`\`${a.name}\`${a.required ? " \\*" : ""} (${a.type}) — ${a.description}`,
						)
						.join("\n"),
				});
			}

			const restrictions: string[] = [];
			if (cmd.ownerOnly) restrictions.push("Only developers");
			if (cmd.adminOnly) restrictions.push("Only administrators");
			if (cmd.allowedUsers?.length) restrictions.push("Specific users");
			if (restrictions.length) {
				embed.addFields({
					name: "Restrictions",
					value: restrictions.join(", "),
				});
			}

			await ctx.reply({ embeds: [embed] });
			return;
		}

		const embed = new EmbedBuilder()
			.setColor(0x5865f2)
			.setTitle("📋 Available commands")
			.setFooter({
				text: `Use /help command or ${prefix}help command for details about a command!`,
			});

		for (const [category, cmds] of ctx.client.commands.getByCategory()) {
			embed.addFields({
				name: category,
				value: cmds.map((c) => `- \`${c.name}\`\n> ${c.description}`).join("\n"),
			});
		}

		await ctx.reply({ embeds: [embed] });
	},
});
