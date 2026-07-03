import { Events } from "discord.js";
import { readdirSync, statSync } from "fs";
import { join } from "path";
import { Logger } from "@/utils/logging";
import { runModuleMigrations } from "../database/migrate";
import type { ModuleDefinition } from "../types";
import type { BotClient } from "./BotClient";

const logger = new Logger("Core.ModuleLoader");

// Guarda os listeners registrados por módulo para poder removê-los no unload
const moduleListeners = new Map<string, Array<{ event: string; handler: Function }>>();

export async function loadModules(
    client: BotClient,
    modulesPath: string,
): Promise<() => Promise<void>> {
    const entries = readdirSync(modulesPath);

    for (const entry of entries) {
        const fullPath = join(modulesPath, entry);
        if (!statSync(fullPath).isDirectory()) continue;
        await loadModule(client, modulesPath, entry).catch((err) => {
            const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
            logger.warn(`Failed to load module "${entry}": ${msg}`);
        });
    }

    return async () => {
        for (const [name, mod] of client.modules) {
            await mod.stop?.(client)?.catch(() => { });
            logger.info(`Stopped module: ${name}`);
        }
    };
}

export async function loadModule(
    client: BotClient,
    modulesPath: string,
    moduleName: string,
): Promise<ModuleDefinition> {
    const fullPath = join(modulesPath, moduleName, "index");

    // Limpa cache do require para garantir código fresco no reload
    clearRequireCache(fullPath);

    const imported = require(fullPath);
    const mod: ModuleDefinition = imported.default ?? imported;

    await registerModule(client, mod);
    logger.info(`Loaded module: ${mod.name}`);
    return mod;
}

export async function unloadModule(
    client: BotClient,
    moduleName: string,
): Promise<void> {
    const mod = client.modules.get(moduleName);
    if (!mod) throw new Error(`Module "${moduleName}" is not loaded.`);

    await mod.stop?.(client)?.catch(() => { });

    // Remove comandos
    for (const cmd of mod.commands ?? []) {
        client.commands.delete(cmd.name);
    }

    // Remove listeners registrados por este módulo
    const listeners = moduleListeners.get(moduleName) ?? [];
    for (const { event, handler } of listeners) {
        client.removeListener(event, handler as never);
    }
    moduleListeners.delete(moduleName);

    client.modules.delete(moduleName);
    logger.info(`Unloaded module: ${moduleName}`);
}

export async function reloadModule(
    client: BotClient,
    modulesPath: string,
    moduleName: string,
): Promise<void> {
    const mod = client.modules.get(moduleName);
    if (!mod) throw new Error(`Module "${moduleName}" is not loaded.`);

    await unloadModule(client, moduleName);
    await loadModule(client, modulesPath, moduleName);
    logger.info(`Reloaded module: ${moduleName}`);
}

// ─── Internals ────────────────────────────────────────────────────────────────

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

    const listeners: Array<{ event: string; handler: Function }> = [];

    for (const [event, handler] of Object.entries(mod.events ?? {})) {
        if (!handler) continue;
        const wrapped = (...args: unknown[]) => (handler as Function)(client, ...args);
        client.on(event, wrapped as never);
        listeners.push({ event, handler: wrapped });
    }

    moduleListeners.set(mod.name, listeners);
    client.modules.set(mod.name, mod);

    if (mod.onReady) {
        const onReady = mod.onReady;
        if (client.isReady()) {
            await onReady(client)?.catch(() => { });
        } else {
            client.once(Events.ClientReady, () => onReady(client));
        }
    }

    await mod.start?.(client);
}

function clearRequireCache(fullPath: string): void {
    const resolved = require.resolve(fullPath);
    delete require.cache[resolved];
}
