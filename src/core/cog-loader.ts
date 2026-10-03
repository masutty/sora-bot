import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { Events } from "discord.js";
import { config } from "@/config";
import { runModuleMigrations } from "@/database/migrate";
import type { Cog } from "@/types";
import { Logger } from "@/utils/logging";
import { newTraceRef, runWithTrace, type TraceContext } from "@/utils/trace";
import type { BotClient } from "./bot-client";
import { describeConflicts, findConflictsWithLoaded, partitionByConflicts } from "./command/command-conflicts";
import { dispatchComponent, validateComponentPrefix } from "./component/component-router";
import { type RunningWorker, startWorker } from "./worker/worker";

const logger = new Logger("core.cogloader");

// Tracks event listeners per cog so they can be removed on unload
type EventHandler = (...args: unknown[]) => unknown;

const cogListeners = new Map<string, Array<{ event: string; handler: EventHandler }>>();

// Tracks running workers per cog so they can be stopped on unload/hot reload
const cogWorkers = new Map<string, RunningWorker[]>();

/** Cog roots, native first: `src/modules` (framework: core, bot_internals) then `src/usermodules`. */
export const COG_ROOTS = [join(__dirname, "../modules"), join(__dirname, "../usermodules")];

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
     * down the rest of the boot, but whoever calls this interactively (`!bot reload`) needs to
     * know that "reloaded" doesn't mean "reloaded everything successfully".
     */
    failures: CogLoadFailure[];
}

/**
 * Loads every cog found in `roots` (one directory = one cog), in root order. The folder name is
 * only used to find the `index` (and to match `DISABLED_COG_DIRS`) - a cog's identity is always
 * `cog.name`, which must be unique across every root.
 */
export async function loadCogs(client: BotClient, roots: string[] = COG_ROOTS): Promise<LoadCogsResult> {
    ensureComponentRouter(client);

    const failures: CogLoadFailure[] = [];
    const recordFailure = (label: string, err: unknown) => {
        const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
        logger.warn(`Failed to load cog "${label}": ${msg}`);
        logger.error(err instanceof Error ? err : new Error(String(err)));
        failures.push({ cog: label, error: msg });
    };

    // Pass 1: require every cog WITHOUT side effects, so command conflicts are known up front.
    const candidates: Cog[] = [];
    for (const root of roots) {
        if (!existsSync(root)) continue; // usermodules may not exist

        for (const entry of readdirSync(root)) {
            const dir = join(root, entry);
            if (!statSync(dir).isDirectory()) continue;

            try {
                const cog = requireCogFromDir(dir);
                if (!cog) continue; // disabled
                if (client.cogs.has(cog.name) || candidates.some((c) => c.name === cog.name)) {
                    throw new Error(`A cog named "${cog.name}" is already loaded.`);
                }
                candidates.push(cog);
            } catch (err) {
                recordFailure(`${basename(root)}/${entry}`, err);
            }
        }
    }

    // Every cog in a conflict is disabled - not just the "second" one - so no module silently
    // wins a command it has to share. `check:commands` catches the same thing at build time.
    const { rejected } = partitionByConflicts(candidates);
    const rejectedNames = new Set(rejected.map((r) => r.cog));
    for (const { cog, conflicts } of rejected) {
        const msg = `disabled - ${describeConflicts(conflicts)}`;
        logger.error(`Cog "${cog}" ${msg}`);
        failures.push({ cog, error: msg });
    }

    // Pass 2: register the rest.
    for (const cog of candidates) {
        if (rejectedNames.has(cog.name)) continue;
        await activateCog(client, cog).catch((err) => recordFailure(cog.name, err));
    }

    return {
        failures,
        stop: async () => {
            for (const [name, cog] of client.cogs) {
                await cog.stop?.(client)?.catch(() => {});
                logger.info(`Stopped cog: ${name}`);
            }
        },
    };
}

/**
 * Unloads a cog: stops it, removes its commands and event listeners.
 */
export async function unloadCog(client: BotClient, cogName: string): Promise<void> {
    const cog = client.cogs.get(cogName);
    if (!cog) throw new Error(`Cog "${cogName}" is not loaded.`);

    await cog.stop?.(client)?.catch(() => {});

    for (const cmd of cog.commands ?? []) {
        client.commands.delete(cmd.name);
    }

    const listeners = cogListeners.get(cogName) ?? [];
    for (const { event, handler } of listeners) {
        client.removeListener(event, handler as never);
    }
    cogListeners.delete(cogName);

    for (const worker of cogWorkers.get(cogName) ?? []) worker.stop();
    cogWorkers.delete(cogName);

    client.cogs.delete(cogName);
    logger.info(`Unloaded cog: ${cogName}`);
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
    require.resolve("./bot-client"),
    require.resolve("./moderation/bot-ban-cache"),
];

/**
 * Hot reloads the whole bot: unloads every cog (stops them, still running the current code in
 * memory), clears the require cache for ALL of `src/` - except `HOT_RELOAD_KEEP_ALIVE` above -
 * then re-registers both the core listeners (`registerCommandHandlers` - command/guard/prefix
 * routing) and the cogs of every root, all freshly re-read from disk. Picks up a change in any file
 * in the bot (a `commands/*.ts`, cog-loader.ts itself, guards, prefix-args.ts) and also detects a
 * brand-new cog (a folder created after boot) - without restarting the process.
 *
 * After clearing the cache, `registerCommandHandlers`/`loadCogs` are fetched via a dynamic
 * `require()` (not this file's static imports) on purpose: the static imports still point at the
 * OLD version (captured when this module was first loaded); only a fresh `require()`, after the
 * cache is cleared, forces Node to re-execute the file and hand back the current version on disk -
 * including this very cog-loader.ts, whose module-scoped `cogListeners` needs to be the SAME
 * instance that will do the next load (and the next unload, on the following reload) to avoid
 * leaking a listener.
 */
export async function hotReloadBot(client: BotClient, roots: string[] = COG_ROOTS): Promise<CogLoadFailure[]> {
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

    const commandHandler = require("@/core/command/command-handler") as typeof import("./command/command-handler");
    commandHandler.registerCommandHandlers(client);

    const cogLoader = require("@/core/cog-loader") as typeof import("./cog-loader");
    const { failures } = await cogLoader.loadCogs(client, roots);
    return failures;
}

// ─── Internals ────────────────────────────────────────────────────────────────

/**
 * Best-effort user/guild for an event's trace, read from the first arg discord.js hands the
 * handler: a `Message` exposes `.author`/`.guildId`, an `Interaction` exposes `.user`/`.guildId` -
 * anything else (a shard event, `ClientReady`, ...) contributes nothing, harmlessly.
 */
export function eventTraceSubject(args: unknown[]): Pick<TraceContext, "userId" | "userTag" | "guildId"> {
    const first = args[0] as
        | {
              user?: { id?: string; username?: string } | null;
              author?: { id?: string; username?: string } | null;
              guildId?: string | null;
          }
        | null
        | undefined;
    if (!first || typeof first !== "object") return {};

    const person = first.user ?? first.author ?? undefined;
    const subject: Pick<TraceContext, "userId" | "userTag" | "guildId"> = {};
    if (person?.id) subject.userId = person.id;
    if (person?.username) subject.userTag = person.username;
    if (first.guildId) subject.guildId = first.guildId;
    return subject;
}

// Whether `ensureComponentRouter` has already wired its listener THIS module lifetime - a hot
// reload gets a fresh one (this whole module, and this flag, are re-required from scratch).
let componentRouterListening = false;

/**
 * Wires the single global `interactionCreate` listener that routes persistent components
 * (`Cog.components`, see `dispatchComponent`) - called once from `loadCogs` (boot, and again after
 * `hotReloadBot` wipes every `InteractionCreate` listener and calls `loadCogs` fresh).
 */
function ensureComponentRouter(client: BotClient): void {
    if (componentRouterListening) return;
    componentRouterListening = true;
    client.on(Events.InteractionCreate, (interaction) => {
        if (!interaction.isMessageComponent()) return;
        void dispatchComponent(client, interaction);
    });
}

async function registerCog(client: BotClient, cog: Cog): Promise<void> {
    for (const component of cog.components ?? []) {
        validateComponentPrefix(cog.name, component);
    }

    if (cog.migrations?.length) {
        await runModuleMigrations(cog.name, cog.migrations);
    }

    for (const cmd of cog.commands ?? []) {
        client.commands.set(cmd.name, cmd);
    }

    const listeners: Array<{ event: string; handler: EventHandler }> = [];

    for (const [event, handler] of Object.entries(cog.events ?? {})) {
        if (!handler) continue;
        const wrapped = (...args: unknown[]) =>
            runWithTrace({ ref: newTraceRef(), command: `event:${cog.name}.${event}`, ...eventTraceSubject(args) }, () =>
                (handler as EventHandler)(client, ...args),
            );
        client.on(event, wrapped as never);
        listeners.push({ event, handler: wrapped });
    }

    cogListeners.set(cog.name, listeners);
    client.cogs.set(cog.name, cog);

    // Workers start once the client is ready, AFTER the cog's onReady (which may prepare state they
    // read, e.g. biomehunt's channel index) - never at load time before login. The array is
    // registered now so an unload before "ready" finds it and nothing starts afterwards.
    const workers: RunningWorker[] = [];
    cogWorkers.set(cog.name, workers);
    const startWorkers = () => {
        if (cogWorkers.get(cog.name) !== workers) return; // unloaded (or reloaded) before ready
        for (const worker of cog.workers ?? []) workers.push(startWorker(cog.name, worker, client));
    };

    const onReady = cog.onReady;
    const runOnReady = async (): Promise<void> => {
        try {
            await onReady?.(client);
        } catch (err) {
            logger.error(err instanceof Error ? err : new Error(String(err)), { cog: cog.name, phase: "onReady" });
        }
    };
    if (client.isReady()) {
        await runOnReady();
        startWorkers();
    } else {
        client.once(Events.ClientReady, async () => {
            await runOnReady();
            startWorkers();
        });
    }

    await cog.start?.(client);
}

/**
 * Fresh `require` of `<dir>/index` - no side effects on the client. Returns `null` for a folder
 * listed in `DISABLED_COG_DIRS`, checked BEFORE the require so a disabled cog never runs any code:
 * the only place the folder name matters, since it's the only name that exists before the require.
 */
function requireCogFromDir(dir: string): Cog | null {
    if (config.bot.disabledCogDirs.includes(basename(dir))) {
        logger.info(`Cog "${basename(dir)}" skipped (DISABLED_COG_DIRS).`);
        return null;
    }

    const indexPath = join(dir, "index");
    clearRequireCache(indexPath);
    const imported = require(indexPath);
    const cog: Cog = imported.default ?? imported;

    if (!cog || typeof cog.name !== "string" || !cog.name) {
        throw new Error('The index did not export a valid Cog - it needs `export default defineCog({ name: "...", ... })`.');
    }
    return cog;
}

/**
 * Registers an already-required cog. Refuses it - before ANY side effect (migrations, commands,
 * listeners) - if one of its commands is owned by another loaded cog.
 */
async function activateCog(client: BotClient, cog: Cog): Promise<void> {
    const conflicts = findConflictsWithLoaded(cog, client.cogs.values());
    if (conflicts.length) throw new Error(`Cog "${cog.name}" refused - ${describeConflicts(conflicts)}`);

    await registerCog(client, cog);
    logger.info(`Loaded cog: ${cog.name}`);
}

function clearRequireCache(fullPath: string): void {
    const resolved = require.resolve(fullPath);
    delete require.cache[resolved];
}
