import dotenv from "dotenv";

dotenv.config({
	path: process.env.NODE_ENV === "production" ? ".env" : ".env.local",
});

import { Events } from "discord.js";
import { join } from "path";
import { config } from "./config";
import { BotClient } from "./core/BotClient";
import {
	registerCommandHandlers,
	registerSlashCommands,
} from "./core/CommandHandler";
import { loadModules } from "./core/ModuleLoader";
import { closePool } from "./database/connection";
import { migrate } from "./database/migrate";
import { Logger } from "./utils/logging";

const logger = new Logger("Core.Bootstrap");

import echoCommand from "./commands/echo";
import helpCommand from "./commands/help";
// ─── Comandos built-in ────────────────────────────────────────────────────────
import pingCommand from "./commands/ping";
import setprefixCommand from "./commands/setprefix";

let stopModules: () => Promise<void> = async () => {};

async function bootstrap(): Promise<void> {
	logger.info("Starting...");

	// 1. Banco de dados
	await migrate();

	// 2. Instancia o client
	const client = new BotClient();

	// 3. Registra comandos built-in
	client.commands.set(pingCommand.name, pingCommand);
	client.commands.set(helpCommand.name, helpCommand);
	client.commands.set(echoCommand.name, echoCommand);
	client.commands.set(setprefixCommand.name, setprefixCommand);

	// 4. Carrega módulos dinamicamente (src/modules/*)
	const modulesPath = join(__dirname, "modules");
	stopModules = await loadModules(client, modulesPath);

	// 5. Registra handlers de prefix e slash
	registerCommandHandlers(client);

	// 6. Login no Discord
	await client.login(config.discord.token);

	// 7. Registra slash commands após ready
	client.once(Events.ClientReady, async () => {
		const guildId =
			config.bot.env === "development" ? process.env.DEV_GUILD_ID : undefined;

		await registerSlashCommands(client, guildId).catch((err) => {
			logger.error(err instanceof Error ? err : new Error(String(err)));
		});

		logger.info(`Bot is ready. ${client.commands.size} commands loaded.`);
	});
}

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
	logger.info(`Signal ${signal} received. Stopping...`);
	await stopModules();
	await closePool();
	process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (err) => {
	logger.error(err instanceof Error ? err : new Error(String(err)));
});

bootstrap().catch((err) => {
	logger.error(err instanceof Error ? err : new Error(String(err)));
	process.exit(1);
});
