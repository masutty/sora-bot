import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { logBuffer } from "./log-buffer";

/** Where trace lines come from; injected so tests never touch disk. */
export interface TraceSources {
    /** Lines in memory, oldest first. */
    bufferLines(): string[];
    /** Log files in the retention window, newest first. */
    logFiles(): Promise<string[]>;
    readLines(file: string): AsyncIterable<string>;
}

/** Trims and strips backticks, so the id can be pasted straight from the `Error ID` line. */
export function normalizeTraceId(raw: string): string {
    return raw.replaceAll("`", "").trim();
}

/** `ref=<id>` or `ref=<id>.<step>`, but never `ref=<id>x`. */
function refPattern(id: string): RegExp {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`ref=${escaped}(?![A-Za-z0-9])`);
}

/** Paths to hide from a log line: the project root becomes `.` and the home folder `~`. */
export interface PrivatePaths {
    root: string;
    home: string;
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A folder in both slash forms, so a `C:\Users\x` root also matches the `C:/Users/x` that some stack frames print. */
function folderPattern(folder: string, ignoreCase: boolean): RegExp | null {
    const clean = folder.replace(/[\\/]+$/, "");
    if (!clean) return null;
    const forms = new Set([clean.replaceAll("/", "\\"), clean.replaceAll("\\", "/")]);
    // Not followed by a name character, so `/app` never matches inside `/application`.
    return new RegExp(`(?:${[...forms].map(escapeRegex).join("|")})(?![\\w.-])`, ignoreCase ? "gi" : "g");
}

/** Hides where the bot runs: the project root becomes `.`, then the home folder becomes `~`. Windows paths ignore case. */
export function sanitizePaths(line: string, paths: PrivatePaths, ignoreCase = process.platform === "win32"): string {
    const root = folderPattern(paths.root, ignoreCase);
    const home = folderPattern(paths.home, ignoreCase);
    const rooted = root ? line.replace(root, ".") : line;
    return home ? rooted.replace(home, "~") : rooted;
}

const timePrefix = (line: string) => line.slice(0, 19);

const ENTRY_START = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} /;

/** Groups lines into log entries (a timestamped line plus its stack/continuation lines) and keeps the ones matching `pattern`. */
function entryCollector(pattern: RegExp, found: Set<string>) {
    let current: string[] = [];
    let match = false;
    let hit = false;
    const flush = () => {
        if (match) {
            found.add(current.join("\n"));
            hit = true;
        }
        current = [];
        match = false;
    };
    return {
        push(line: string) {
            if (ENTRY_START.test(line)) {
                flush();
                match = pattern.test(line);
            }
            current.push(line);
        },
        /** Ends the current entry; true if any entry matched so far. */
        end() {
            flush();
            return hit;
        },
    };
}

/** Every log line of one invocation (stack traces included), oldest first, from memory and the combined log files. */
export async function findTraceLines(
    rawId: string,
    sources: TraceSources,
    paths: PrivatePaths = { root: process.cwd(), home: homedir() },
): Promise<string[]> {
    const id = normalizeTraceId(rawId);
    if (!id) return [];
    const found = new Set<string>();
    const pattern = refPattern(id);

    for (const entry of sources.bufferLines()) {
        const collector = entryCollector(pattern, found);
        for (const line of entry.split("\n")) collector.push(line);
        collector.end();
    }

    // An invocation lives in one or two neighbouring files: stop at the first file without it once one had it.
    let seenInFile = false;
    for (const file of await sources.logFiles()) {
        const collector = entryCollector(pattern, found);
        for await (const line of sources.readLines(file)) collector.push(line);
        if (collector.end()) seenInFile = true;
        else if (seenInFile) break;
    }

    // Stable sort: entries of the same second keep their order.
    return [...found]
        .sort((a, b) => timePrefix(a).localeCompare(timePrefix(b)))
        .flatMap((e) => e.split("\n").map((line) => sanitizePaths(line, paths)));
}

const COMBINED_FILE = /^combined-\d{4}-\d{2}-\d{2}.*\.log$/;

/** Memory buffer plus `logs/combined-*.log`, newest `retentionDays` files, streamed line by line. */
export function diskTraceSources(retentionDays: number, dir = "logs"): TraceSources {
    return {
        bufferLines: () => logBuffer.entries().map((e) => e.text),
        logFiles: async () =>
            (await readdir(dir))
                .filter((f) => COMBINED_FILE.test(f))
                .sort()
                .reverse()
                .slice(0, retentionDays)
                .map((f) => `${dir}/${f}`),
        readLines: (file) => createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity }),
    };
}

// `2026-11-25 10:00:00 error   [namespace] (ref=abc !warn u=tag(1) g=2): message`
export const LOG_LINE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (\w+)\s*(?:\[[^\]]*\] )?\(ref=\S+ ?(.*?)\): (.*)$/;

/** What the log lines of one invocation say about it; a field is null when no line has it. */
export interface TraceFacts {
    /** `!warn` (prefix) or `/warn` (slash). */
    command: string | null;
    userId: string | null;
    userTag: string | null;
    guildId: string | null;
    /** The arguments as one `name=value, name=value` text; empty when the command took none. Null when the log did not record them. */
    args: string | null;
    outcome: "ok" | "user-error" | "error" | null;
    tookMs: number | null;
    /** The message of a user error, from the outcome line. */
    userError: string | null;
    /** `2026-11-25 10:00:00`, from the first line. */
    time: string | null;
}

const ARG_PAIR = /([\w-]+)=`((?:(?!`\s+[\w-]+=`)[\s\S])*?)`(?=\s+[\w-]+=`|$)/g;

/** `user=\`<@1>\` reason=\`spam\`` (how the log writes args) -> `user=<@1>, reason=spam`. */
export function readArgs(text: string): string {
    return [...text.matchAll(ARG_PAIR)].map((m) => `${m[1]}=${(m[2] as string).replaceAll("`", "'")}`).join(", ");
}

export function readTraceFacts(lines: string[]): TraceFacts {
    const facts: TraceFacts = {
        command: null,
        userId: null,
        userTag: null,
        guildId: null,
        args: null,
        outcome: null,
        tookMs: null,
        userError: null,
        time: null,
    };
    let headerRead = false;
    for (const line of lines) {
        const m = LOG_LINE.exec(line);
        if (!m) continue;
        const [, time, , trace = "", message = ""] = m;
        if (!headerRead) {
            headerRead = true;
            facts.time = time as string;
            facts.command = /(?:^|\s)([!/][^\s]+(?: [a-z-]+)*?)(?=\s+u=|\s+g=|$)/.exec(trace)?.[1] ?? null;
            const user = /u=([^\s(]*)\((\d+)\)/.exec(trace);
            facts.userTag = user?.[1] || null;
            facts.userId = user?.[2] ?? /u=(\d+)/.exec(trace)?.[1] ?? null;
            facts.guildId = /g=(\d+)/.exec(trace)?.[1] ?? null;
        }
        // A bare "invoked" is an older log that did not record arguments: unknown, so `args` stays null.
        if (message === "invoked with no arguments") facts.args = "";
        else if (message.startsWith("invoked with ")) facts.args = readArgs(message.slice("invoked with ".length));
        const outcome = /^(ok|user-error|error) in (\d+)ms(?:: (.*))?$/.exec(message);
        if (outcome) {
            facts.outcome = outcome[1] as TraceFacts["outcome"];
            facts.tookMs = Number(outcome[2]);
            facts.userError = outcome[1] === "user-error" ? (outcome[3]?.replace(/ \(args: [\s\S]*\)$/, "") ?? null) : null;
        }
    }
    return facts;
}
