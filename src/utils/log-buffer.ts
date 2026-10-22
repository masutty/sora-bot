import Transport from "winston-transport";
import type { LogLevel } from "./logging";

export const BUFFER_SIZE = 1000;
export const ENTRY_MAX_CHARS = 16 * 1024;

export interface LogEntry {
    level: LogLevel;
    namespace: string | null;
    /** Full plain formatted line(s), identical to a `combined-*.log` line (may be multi-line). */
    text: string;
}

/** Fixed-capacity in-memory log history - the oldest entry is dropped once full. */
export class LogRingBuffer {
    private readonly items: LogEntry[] = [];

    constructor(private readonly capacity: number) {}

    push(entry: LogEntry): void {
        this.items.push(entry);
        if (this.items.length > this.capacity) this.items.shift();
    }

    /** Oldest -> newest. */
    entries(): readonly LogEntry[] {
        return this.items;
    }
}

/** Feeds every log line that reaches it into a `LogRingBuffer`. Gets the format from the caller (logging.ts) so this file never imports runtime values from it. */
export class BufferTransport extends Transport {
    constructor(
        private readonly buffer: LogRingBuffer,
        opts?: Transport.TransportStreamOptions,
    ) {
        super(opts);
    }

    override log(info: Record<string | symbol, unknown>, next: () => void): void {
        let text = String(info[Symbol.for("message")] ?? "");
        if (text.length > ENTRY_MAX_CHARS) {
            let end = ENTRY_MAX_CHARS - 1;
            // Don't cut between the two halves of a surrogate pair.
            if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
            text = `${text.slice(0, end)}…`;
        }

        this.buffer.push({
            level: info.level as LogLevel,
            namespace: typeof info.namespace === "string" ? info.namespace : null,
            text,
        });
        next();
    }
}

export const logBuffer = new LogRingBuffer(BUFFER_SIZE);
