import { Events } from "discord.js";
import { readdirSync, statSync } from "fs";
import { join } from "path";
import { Logger } from "@/utils/logging";
import { runModuleMigrations } from "../database/migrate";
import type { ModuleDefinition } from "../types";
import type { BotClient } from "./BotClient";

const logger = new Logger("Core.ModuleLoader");

export async function loadModules(
	client: BotClient,
	modulesPath: string,
): Promise<() => Promise<void>> {
	const entries = readdirSync(modulesPath);
	const loaded: ModuleDefinition[] = [];

	for (const entry of entries) {
		const fullPath = join(modulesPath, entry);
		if (!statSync(fullPath).isDirectory()) continue;

		let mod: ModuleDefinition;
		try {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const imported = require(join(fullPath, "index"));
			mod = imported.default ?? imported;
		} catch (err) {
			const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
			logger.warn(`Failed to load module "${entry}": ${msg}`);
			continue;
		}

		await registerModule(client, mod);
		loaded.push(mod);
		logger.info(`Loaded module: ${mod.name}`);
	}

	// Return a cleanup function that calls stop() on each module
	return async () => {
		await Promise.all(loaded.map((m) => m.stop?.(client)));
	};
}

async function registerModule(
	client: BotClient,
	mod: ModuleDefinition,
): Promise<void> {
	if (mod.migrations?.length) {
		await runModuleMigrations(mod.name, mod.migrations);
	}

	for (const cmd of mod.commands ?? []) {
		client.commands.set(cmd.name, cmd);
	}

	for (const [event, handler] of Object.entries(mod.events ?? {})) {
		if (!handler) continue;
		client.on(event, (...args: unknown[]) => (handler as Function)(client, ...args));
	}

	if (mod.onReady) {
		const onReady = mod.onReady;
		client.once(Events.ClientReady, () => onReady(client));
	}

	await mod.start?.(client);
}
