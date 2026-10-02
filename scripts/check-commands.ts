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
 * and on duplicate cog names - across EVERY module on disk (src/modules and src/usermodules),
 * ignoring DISABLED_COG_DIRS: the build doesn't know which .env will run, so two modules that can't
 * coexist in the repo are already an error.
 *
 * `--verbose` / `-v` also lists which top-level commands each module declares.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { findCommandConflicts } from "@/core/command/command-conflicts";
import { buildSlashJson } from "@/core/command/command-dispatch";
import type { Cog } from "@/types";

const roots = ["modules", "usermodules"].map((d) => join(__dirname, "../src", d));
const verbose = process.argv.includes("--verbose") || process.argv.includes("-v");
let ok = true;
const cogs: Cog[] = [];

for (const modulesPath of roots) {
    if (!existsSync(modulesPath)) continue;

    for (const entry of readdirSync(modulesPath)) {
        const fullPath = join(modulesPath, entry);
        if (!statSync(fullPath).isDirectory()) continue;

        try {
            const imported = require(join(fullPath, "index"));
            const cog: Cog = imported.default ?? imported;
            if (cogs.some((c) => c.name === cog.name)) throw new Error(`duplicate cog name "${cog.name}"`);
            cogs.push(cog);

            for (const cmd of cog.commands ?? []) {
                // The exact body registerSlashCommands sends - validates what really gets registered.
                buildSlashJson(cmd);
            }
        } catch (err) {
            ok = false;
            console.error(`❌ ${fullPath}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}

if (verbose) {
    const width = Math.max(0, ...cogs.map((c) => c.name.length));
    for (const cog of cogs) {
        const names = (cog.commands ?? []).map((c) => c.name);
        console.log(`   ${cog.name.padEnd(width)}  ${names.length ? names.join(", ") : "(no commands)"}`);
    }
}

for (const { command, cogs: owners } of findCommandConflicts(cogs)) {
    ok = false;
    console.error(`❌ command "${command}" declared by: ${owners.join(", ")}`);
}

if (ok) console.log(`✅ All command trees valid, no command conflicts.`);
process.exit(ok ? 0 : 1);
