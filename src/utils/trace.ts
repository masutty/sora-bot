import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

/**
 * Who/what a log line belongs to. Set once where work starts (a command invocation; a View click)
 * and read by every `Logger` call made anywhere below it - services, repositories, Views - without
 * passing anything around.
 */
export interface TraceContext {
    /** Short id of one command invocation - shown to the user on internal errors ("ref"), so a report maps to the logs. */
    inv: string;
    /** A later step of the same invocation, e.g. a View click: `"<n>:<key>"`. */
    step?: string;
    /** `"bh balance"`, `"bh-admin forward set"`... (name + group + subcommand). */
    command?: string;
    mode?: "slash" | "prefix";
    userId?: string;
    userTag?: string;
    guildId?: string;
}

const storage = new AsyncLocalStorage<TraceContext>();

/** Runs `fn` with `trace` as the current context; it follows every await, timer and promise inside. */
export function runWithTrace<T>(trace: TraceContext, fn: () => T): T {
    return storage.run(trace, fn);
}

export function currentTrace(): TraceContext | undefined {
    return storage.getStore();
}

/** 8 lowercase base36 chars - short enough to read out of a screenshot, ~41 bits of randomness. */
export function newInvocationId(): string {
    const n = randomBytes(6).readUIntBE(0, 6);
    return n.toString(36).padStart(8, "0").slice(-8);
}

/** `inv=k3f9a2x1.2:back /bh balance u=masutty(1888...) g=1234...` - only the fields that are set. */
export function formatTrace(trace: TraceContext | undefined): string {
    if (!trace) return "";
    const parts = [`inv=${trace.inv}${trace.step ? `.${trace.step}` : ""}`];
    if (trace.command) parts.push(`${trace.mode === "prefix" ? "!" : "/"}${trace.command}`);
    if (trace.userId) parts.push(`u=${trace.userTag ? `${trace.userTag}(${trace.userId})` : trace.userId}`);
    if (trace.guildId) parts.push(`g=${trace.guildId}`);
    return parts.join(" ");
}
