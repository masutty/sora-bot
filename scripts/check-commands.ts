/**
 * Loads every cog module and replays the exact same builder construction that
 * `registerSlashCommands` (src/core/command/command-handler.ts) does at real boot time - including the
 * fallback `SlashCommandBuilder` for commands with no `.options` (defineCommand alone only
 * validates commands that already have `.options`; a description-only command never touches
 * discord.js's validator until slash registration, at actual boot - this closes that gap).
 * Throws synchronously at construction time, no DB/Discord connection needed, so this is a
 * sub-second sanity check to run before deploying instead of finding out at bot boot.
 *
 * Also fails on command-name conflicts between modules (see src/core/command/command-conflicts.ts) -
 * across EVERY module on disk, ignoring DISABLED_COGS: the build doesn't know which .env will run,
 * so two modules that can't coexist in the repo are already an error.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { findCommandConflicts } from "@/core/command/command-conflicts";
import { buildSlashJson } from "@/core/command/command-dispatch";
import type { Cog } from "@/types";

const modulesPath = join(__dirname, "../src/modules");
let ok = true;
const cogs: Cog[] = [];

for (const entry of readdirSync(modulesPath)) {
    const fullPath = join(modulesPath, entry);
    if (!statSync(fullPath).isDirectory()) continue;

    try {
        const imported = require(join(fullPath, "index"));
        const cog: Cog = imported.default ?? imported;
        cogs.push(cog);

        for (const cmd of cog.commands ?? []) {
            // The exact body registerSlashCommands sends - validates what really gets registered.
            buildSlashJson(cmd);
        }
    } catch (err) {
        ok = false;
        console.error(`❌ ${entry}: ${err instanceof Error ? err.message : String(err)}`);
    }
}

for (const { command, cogs: owners } of findCommandConflicts(cogs)) {
    ok = false;
    console.error(`❌ command "${command}" declared by: ${owners.join(", ")}`);
}

if (ok) console.log(`✅ All command trees valid, no command conflicts.`);
process.exit(ok ? 0 : 1);
