import {
	type ChatInputCommandInteraction,
	EmbedBuilder,
	Events,
	type Message,
	REST,
	Routes,
	SlashCommandBuilder,
} from "discord.js";
import { Logger } from "@/utils/logging";
import { config } from "../config";
import { getGuildPrefix } from "../database/guildRepository";
import type { BotClient } from "./BotClient";
import { PrefixCommandContext, SlashCommandContext } from "./context";
import { checkGuards } from "./guards";

const logger = new Logger("Core.CommandHandler");
const slashLogger = new Logger("Core.SlashCmd");

// ─── Command Handlers ──────────────────────────────────────────────────────────

export function registerCommandHandlers(client: BotClient): void {
	client.on(Events.MessageCreate, async (message: Message) => {
		if (message.author.bot || !message.guild) return;

		const prefix = await getGuildPrefix(message.guild.id);
		if (!message.content.startsWith(prefix)) return;

		const [commandName, ...args] = message.content
			.slice(prefix.length)
			.trim()
			.split(/\s+/);

		if (!commandName) return;

		const command = client.commands.get(commandName.toLowerCase());
		if (!command) return;

		try {
			if (command.execute) {
				const ctx = new PrefixCommandContext(
					message,
					args,
					command.args ?? [],
					client,
				);
				const guardError = await checkGuards(ctx, command);
				if (guardError) {
					await ctx.reply({ embeds: [errorEmbed(guardError)] });
					return;
				}
				await command.execute(ctx);
			} else if (command.executePrefix) {
				await command.executePrefix(message, args, client);
			}
		} catch (err) {
			logger.error(err instanceof Error ? err : new Error(String(err)), {
				command: commandName,
			});
			await message
				.reply({
					embeds: [
						errorEmbed("Something went wrong trying to run this command."),
					],
				})
				.catch(() => {});
		}
	});

	client.on(Events.InteractionCreate, async (interaction) => {
		if (!interaction.isChatInputCommand()) return;

		const command = client.commands.get(interaction.commandName);
		if (!command) {
			await interaction.reply({ content: "Unknown command.", ephemeral: true });
			return;
		}

		try {
			if (command.execute) {
				const ctx = new SlashCommandContext(
					interaction as ChatInputCommandInteraction,
					client,
				);
				const guardError = await checkGuards(ctx, command);
				if (guardError) {
					await ctx.reply({
						embeds: [errorEmbed(guardError)],
						ephemeral: true,
					});
					return;
				}
				await command.execute(ctx);
			} else if (command.executeSlash) {
				await command.executeSlash(
					interaction as ChatInputCommandInteraction,
					client,
				);
			}
		} catch (err) {
			logger.error(err instanceof Error ? err : new Error(String(err)), {
				command: interaction.commandName,
			});

			const payload = {
				embeds: [
					errorEmbed("Something went wrong trying to run this command."),
				],
				ephemeral: true,
			};

			if (interaction.replied || interaction.deferred) {
				await interaction.followUp(payload).catch(() => {});
			} else {
				await interaction.reply(payload).catch(() => {});
			}
		}
	});
}

// ─── Slash Command Registration ────────────────────────────────────────────────

export async function registerSlashCommands(
	client: BotClient,
	guildId?: string,
): Promise<void> {
	const rest = new REST().setToken(config.discord.token);

	const builders = client.commands.getAll().map((cmd) => {
		if (cmd.slashBuilder) return cmd.slashBuilder.toJSON();

		const builder = new SlashCommandBuilder()
			.setName(cmd.name)
			.setDescription(cmd.description);

		for (const arg of cmd.args ?? []) {
			if (arg.type === "string") {
				builder.addStringOption((opt) =>
					opt
						.setName(arg.name)
						.setDescription(arg.description)
						.setRequired(arg.required),
				);
			} else if (arg.type === "number") {
				builder.addNumberOption((opt) =>
					opt
						.setName(arg.name)
						.setDescription(arg.description)
						.setRequired(arg.required),
				);
			} else if (arg.type === "boolean") {
				builder.addBooleanOption((opt) =>
					opt
						.setName(arg.name)
						.setDescription(arg.description)
						.setRequired(arg.required),
				);
			} else if (arg.type === "user") {
				builder.addUserOption((opt) =>
					opt
						.setName(arg.name)
						.setDescription(arg.description)
						.setRequired(arg.required),
				);
			} else if (arg.type === "channel") {
				builder.addChannelOption((opt) =>
					opt
						.setName(arg.name)
						.setDescription(arg.description)
						.setRequired(arg.required),
				);
			} else if (arg.type === "role") {
				builder.addRoleOption((opt) =>
					opt
						.setName(arg.name)
						.setDescription(arg.description)
						.setRequired(arg.required),
				);
			}
		}

		return builder.toJSON();
	});

	try {
		const route = guildId
			? Routes.applicationGuildCommands(config.discord.clientId, guildId)
			: Routes.applicationCommands(config.discord.clientId);

		await rest.put(route, { body: builders });
		slashLogger.info(
			`${builders.length} commands registered ${guildId ? `in guild ${guildId}` : "globally"}.`,
		);
	} catch (err) {
		slashLogger.error(err instanceof Error ? err : new Error(String(err)));
		throw err;
	}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function errorEmbed(msg: string): EmbedBuilder {
	return new EmbedBuilder().setColor(0xff0000).setDescription(`❌ ${msg}`);
}
