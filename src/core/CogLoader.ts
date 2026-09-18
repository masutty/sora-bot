import { Events } from "discord.js";
import { mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { config } from "@/config";
import { Logger } from "@/utils/logging";
import { runModuleMigrations } from "@/database/migrate";
import type { Cog } from "@/types";
import type { BotClient } from "./BotClient";

const logger = new Logger("core.cogloader");

// Tracks event listeners per cog so they can be removed on unload
const cogListeners = new Map<string, Array<{ event: string; handler: Function }>>();

// Which base directory each loaded cog came from - `reloadCog` consults this instead of blindly
// trusting the `cogsPath` it's handed.
const cogOrigin = new Map<string, string>();

// ─── Public API ───────────────────────────────────────────────────────────────

export interface CogLoadFailure {
    cog: string;
    error: string;
}

export interface LoadCogsResult {
    /** Calls `stop()` on every loaded cog - for graceful shutdown. */
    stop: () => Promise<void>;
    /**
     * Cogs that failed to load (already logged as warn/error here) - a broken cog does NOT bring
     * down the rest of the boot, but whoever calls this interactively (`!bot reload-all`) needs to
     * know that "reloaded" doesn't mean "reloaded everything successfully".
     */
    failures: CogLoadFailure[];
}

/**
 * Loads all cogs found in `cogsPath` (one directory = one cog).
 */
export async function loadCogs(
    client: BotClient,
    cogsPath: string,
): Promise<LoadCogsResult> {
    const entries = readdirSync(cogsPath);
    const failures: CogLoadFailure[] = [];

    for (const entry of entries) {
        const fullPath = join(cogsPath, entry);
        if (!statSync(fullPath).isDirectory()) continue;

        if (config.bot.disabledCogs.includes(entry)) {
            logger.info(`Cog "${entry}" skipped (DISABLED_COGS).`);
            continue;
        }

        await loadCog(client, cogsPath, entry).catch((err) => {
            const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
            logger.warn(`Failed to load cog "${entry}": ${msg}`);
            logger.error(err);
            failures.push({ cog: entry, error: msg });
        });
    }

    return {
        failures,
        stop: async () => {
            for (const [name, cog] of client.cogs) {
                await cog.stop?.(client)?.catch(() => { });
                logger.info(`Stopped cog: ${name}`);
            }
        },
    };
}

/**
 * Loads a single cog by name from `cogsPath/<cogName>/index`.
 */
export async function loadCog(
    client: BotClient,
    cogsPath: string,
    cogName: string,
): Promise<Cog> {
    const fullPath = join(cogsPath, cogName, "index");

    clearRequireCache(fullPath);

    const imported = require(fullPath);
    const cog: Cog = imported.default ?? imported;

    cogOrigin.set(cog.name, cogsPath);
    await registerCog(client, cog);
    logger.info(`Loaded cog: ${cog.name}`);
    return cog;
}

/** Which base directory a cog was loaded from - `undefined` if never loaded this session. */
export function getCogOrigin(cogName: string): string | undefined {
    return cogOrigin.get(cogName);
}

/**
 * Unloads a cog: stops it, removes its commands and event listeners.
 */
export async function unloadCog(
    client: BotClient,
    cogName: string,
): Promise<void> {
    const cog = client.cogs.get(cogName);
    if (!cog) throw new Error(`Cog "${cogName}" is not loaded.`);

    await cog.stop?.(client)?.catch(() => { });

    for (const cmd of cog.commands ?? []) {
        client.commands.delete(cmd.name);
    }

    const listeners = cogListeners.get(cogName) ?? [];
    for (const { event, handler } of listeners) {
        client.removeListener(event, handler as never);
    }
    cogListeners.delete(cogName);

    client.cogs.delete(cogName);
    logger.info(`Unloaded cog: ${cogName}`);
}

/**
 * Reloads a cog (unload + load from disk).
 */
export async function reloadCog(
    client: BotClient,
    cogsPath: string,
    cogName: string,
): Promise<void> {
    if (!client.cogs.has(cogName)) throw new Error(`Cog "${cogName}" is not loaded.`);

    const basePath = cogOrigin.get(cogName) ?? cogsPath;
    await unloadCog(client, cogName);
    await loadCog(client, basePath, cogName);
    logger.info(`Reloaded cog: ${cogName}`);
}

export interface InstallCogResult {
    name: string;
    commands: number;
    /** true = a cog with this name was already loaded in memory and got replaced (not deleted). */
    overwritten: boolean;
}

const DCL_RUNTIME_DIRNAME = ".dcl-runtime";

/**
 * Sandbox directory for cogs installed via `!dcl run` - a SIBLING of `cogsPath` (`src/modules`),
 * not a child of it, on purpose: `readdirSync(cogsPath)` (used by `loadCogs`/`hotReloadBot` to
 * rescan everything) never lists what's in here. That's what guarantees a cog installed via DCL
 * never "sticks around" - it disappears completely on a full reload or a process restart, with no
 * exclusion list required.
 */
export function getDclRuntimeDir(cogsPath: string): string {
    return join(cogsPath, "..", DCL_RUNTIME_DIRNAME);
}

/**
 * Installs/updates a cog at RUNTIME from the source of a single `index.ts` (`!dcl run`) - ALWAYS
 * inside the `getDclRuntimeDir` sandbox, NEVER in the real `cogsPath` (`src/modules`).
 *
 * Writes to a staging directory (inside the sandbox itself) and REQUIRES (doesn't trust
 * regex/text) that `require()` + `defineCog()` actually produce a valid Cog before touching any
 * bot state - if the require fails (syntax error, no `export default`, whatever), nothing already
 * running is affected, the staging dir is deleted, and the error bubbles up to the caller.
 *
 * "Overwrite" (`cog.name` already loaded, even if it's a real cog from the repo) ONLY swaps what's
 * in MEMORY (`unloadCog` - removes commands/listeners, doesn't touch any file). The real
 * `index.ts` in `src/modules/<name>`, if it exists, is NEVER read, moved, or deleted by this
 * function - it stays exactly as it was. A full reload (`!bot reload-all`) or restarting the
 * process goes back to loading that real cog from disk normally; the version installed via DCL is
 * forgotten (the whole sandbox is wiped on boot, see `src/index.ts`).
 */
export async function installCogFromSource(
    client: BotClient,
    cogsPath: string,
    source: string,
): Promise<InstallCogResult> {
    const runtimeDir = getDclRuntimeDir(cogsPath);
    const stagingDir = join(runtimeDir, ".staging");
    const stagingIndex = join(stagingDir, "index");

    rmSync(stagingDir, { recursive: true, force: true });
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(`${stagingIndex}.ts`, source, "utf8");

    let cog: Cog;
    try {
        clearRequireCache(stagingIndex);
        const imported = require(stagingIndex);
        cog = imported.default ?? imported;
    } catch (err) {
        rmSync(stagingDir, { recursive: true, force: true });
        throw err;
    }

    if (!cog || typeof cog.name !== "string" || !cog.name) {
        rmSync(stagingDir, { recursive: true, force: true });
        throw new Error('The file did not export a valid Cog - it needs `export default defineCog({ name: "...", ... })`.');
    }

    // Memory only - the real cog in `cogsPath` (if the name collides with one) is left untouched.
    const overwritten = client.cogs.has(cog.name);
    if (overwritten) await unloadCog(client, cog.name);

    // Sandbox only - never in `cogsPath`.
    const finalDir = join(runtimeDir, cog.name);
    rmSync(finalDir, { recursive: true, force: true });
    renameSync(stagingDir, finalDir);

    const loaded = await loadCog(client, runtimeDir, cog.name);
    logger.info(`Cog installed via DCL (runtime, ${runtimeDir}): ${loaded.name}${overwritten ? " (replaced the in-memory version)" : ""}`);
    return {
        name: loaded.name,
        commands: loaded.commands?.length ?? 0,
        overwritten,
    };
}

// Files with live state that CANNOT be reinstantiated out from under whoever already holds a
// reference to them: the open connection pool (database/connection), the log transports holding
// open file handles and the running event-loop histogram (utils/logging, utils/metrics), and the
// client class itself (never reinstantiated, only exists for `instanceof` consistency).
// Left out of hotReloadBot's cache clear - everything else under `src/` is reset.
//
// RELATIVE path on purpose, never the `@/...` alias - `tsc-alias` (which rewrites aliases to
// relative paths in the production build) only recognizes plain `require("@/...")` text;
// `require.resolve` doesn't match its rewrite regex, so an alias here would survive raw into
// `dist/` - works in dev (via tsconfig-paths) and breaks in production with "Cannot find module
// '@/config'". A relative path doesn't depend on any rewrite, so it works the same in both.
const HOT_RELOAD_KEEP_ALIVE = [
    require.resolve("../config"),
    require.resolve("../database/connection"),
    require.resolve("../utils/logging"),
    require.resolve("../utils/metrics"),
    require.resolve("./BotClient"),
];

/**
 * Hot reloads the whole bot: unloads every cog (stops them, still running the current code in
 * memory), clears the require cache for ALL of `src/` - except `HOT_RELOAD_KEEP_ALIVE` above -
 * then re-registers both the core listeners (`registerCommandHandlers` - command/guard/prefix
 * routing) and the cogs, all freshly re-read from disk. Unlike `reloadCog`, which only clears ONE
 * cog's `index.ts`: this picks up a change in any file in the bot (a `commands/*.ts`, CogLoader
 * itself, guards, PrefixArgs) and also detects a brand-new cog (a folder created after boot) -
 * without restarting the process.
 *
 * After clearing the cache, `registerCommandHandlers`/`loadCogs` are fetched via a dynamic
 * `require()` (not this file's static imports) on purpose: the static imports still point at the
 * OLD version (captured when this module was first loaded); only a fresh `require()`, after the
 * cache is cleared, forces Node to re-execute the file and hand back the current version on disk -
 * including this very CogLoader.ts, whose module-scoped `cogListeners` needs to be the SAME
 * instance that will do the next load (and the next unload, on the following reload) to avoid
 * leaking a listener.
 */
export async function hotReloadBot(
    client: BotClient,
    cogsPath: string,
): Promise<CogLoadFailure[]> {
    for (const name of [...client.cogs.keys()]) {
        await unloadCog(client, name).catch((err) => {
            logger.warn(`Failed to unload cog "${name}" before full reload: ${err instanceof Error ? err.message : String(err)}`);
        });
    }

    const srcRoot = join(__dirname, "..");
    const keepAlive = new Set(HOT_RELOAD_KEEP_ALIVE);
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(srcRoot) && !keepAlive.has(key)) delete require.cache[key];
    }

    client.removeAllListeners(Events.MessageCreate);
    client.removeAllListeners(Events.InteractionCreate);

    const commandHandler = require("@/core/CommandHandler") as typeof import("./CommandHandler");
    commandHandler.registerCommandHandlers(client);

    const cogLoader = require("@/core/CogLoader") as typeof import("./CogLoader");
    const { failures } = await cogLoader.loadCogs(client, cogsPath);
    return failures;
}

// ─── Internals ────────────────────────────────────────────────────────────────

async function registerCog(client: BotClient, cog: Cog): Promise<void> {
    if (cog.migrations?.length) {
        await runModuleMigrations(cog.name, cog.migrations);
    }

    for (const cmd of cog.commands ?? []) {
        client.commands.set(cmd.name, cmd);
    }

    const listeners: Array<{ event: string; handler: Function }> = [];

    for (const [event, handler] of Object.entries(cog.events ?? {})) {
        if (!handler) continue;
        const wrapped = (...args: unknown[]) => (handler as Function)(client, ...args);
        client.on(event, wrapped as never);
        listeners.push({ event, handler: wrapped });
    }

    cogListeners.set(cog.name, listeners);
    client.cogs.set(cog.name, cog);

    if (cog.onReady) {
        const onReady = cog.onReady;
        if (client.isReady()) {
            await onReady(client)?.catch(() => { });
        } else {
            client.once(Events.ClientReady, () => onReady(client));
        }
    }

    await cog.start?.(client);
}

function clearRequireCache(fullPath: string): void {
    const resolved = require.resolve(fullPath);
    delete require.cache[resolved];
}
