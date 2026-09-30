/**
 * Command-name conflict detection between cogs. Slash and prefix share ONE registry keyed by the
 * top-level name (case-insensitive, see `CommandRegistry`), so two cogs that both want `profile`
 * can't coexist - whichever loaded first would silently win. Used by `scripts/check-commands.ts`
 * (fails the build) and by the cog loader (disables every cog involved at boot, refuses a single
 * incoming cog at runtime).
 */

/** The only shape this needs from a Cog - keeps it testable without a full `Cog`. */
export interface CogCommandNames {
    name: string;
    commands?: ReadonlyArray<{ name: string }>;
}

export interface CommandConflict {
    /** Lowercased command name. */
    command: string;
    /** Every cog declaring it, in load order - a cog repeats if it declares the name twice. */
    cogs: string[];
}

export interface RejectedCog {
    cog: string;
    conflicts: CommandConflict[];
}

export function findCommandConflicts(cogs: ReadonlyArray<CogCommandNames>): CommandConflict[] {
    const owners = new Map<string, string[]>();
    for (const cog of cogs) {
        for (const cmd of cog.commands ?? []) {
            const key = cmd.name.toLowerCase();
            owners.set(key, [...(owners.get(key) ?? []), cog.name]);
        }
    }
    return [...owners].filter(([, list]) => list.length > 1).map(([command, list]) => ({ command, cogs: list }));
}

/** Splits cogs into the ones safe to load and the ones involved in any conflict (all of them, not just the "second"). */
export function partitionByConflicts<T extends CogCommandNames>(cogs: ReadonlyArray<T>): { accepted: T[]; rejected: RejectedCog[] } {
    const conflicts = findCommandConflicts(cogs);
    const accepted: T[] = [];
    const rejected: RejectedCog[] = [];
    for (const cog of cogs) {
        const mine = conflicts.filter((c) => c.cogs.includes(cog.name));
        if (mine.length) rejected.push({ cog: cog.name, conflicts: mine });
        else accepted.push(cog);
    }
    return { accepted, rejected };
}

/**
 * Conflicts an incoming cog would cause against what's already loaded. A loaded cog with the same
 * name is ignored - it's the one being replaced (reload / `!dcl run` overwrite).
 */
export function findConflictsWithLoaded(incoming: CogCommandNames, loaded: Iterable<CogCommandNames>): CommandConflict[] {
    const others = [...loaded].filter((c) => c.name !== incoming.name);
    return findCommandConflicts([...others, incoming]).filter((c) => c.cogs.includes(incoming.name));
}

export function describeConflicts(conflicts: ReadonlyArray<CommandConflict>): string {
    return conflicts.map((c) => `command "${c.command}" declared by: ${c.cogs.join(", ")}`).join("; ");
}
