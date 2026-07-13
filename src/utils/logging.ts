import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";

const { combine, timestamp, printf, colorize, errors } = winston.format;

/**
 * Custom level ranking - `verbose` sits BELOW `debug` (higher number = less severe = more
 * detail), the opposite of winston's built-in npm levels (where verbose=4 < debug=5). This is
 * deliberate: it lets `debug` mean "normal diagnostic detail" and `verbose` mean "the extra
 * noisy stuff" (macro/biome parsing traces) - console at `debug` shows the former without the
 * latter; bump to `verbose` to see everything.
 */
const customLevels = {
	levels: { error: 0, warn: 1, info: 2, debug: 3, verbose: 4 },
	colors: { error: "red", warn: "yellow", info: "green", debug: "blue", verbose: "gray" },
};
winston.addColors(customLevels.colors);

const LEVEL_WIDTH = 7; // longest used level: "verbose"

const logFormat = printf(({ level, message, timestamp, namespace, stack }) => {
	// level is already colorized — strip ANSI to measure true display length
	const displayLen = level.replace(/\x1B\[[0-9;]*m/g, "").length;
	const padding = " ".repeat(Math.max(0, LEVEL_WIDTH - displayLen));
	const ns = namespace ? ` [${namespace}]` : "";
	const trace = stack ? `\n${stack}` : "";
	return `${timestamp} ${level}${padding}${ns}: ${message}${trace}`;
});

// Shared, colorize-free base - safe to reuse across transports since it never adds ANSI codes.
const commonFormat = combine(errors({ stack: true }), timestamp({ format: "YYYY-MM-DD HH:mm:ss" }));
const plainFormat = combine(commonFormat, logFormat);

/** Valid levels this app actually uses - restricts what `setLogLevel` accepts so a typo can't silently no-op. Ordered least to most verbose. */
export const LOG_LEVELS = ["error", "warn", "info", "debug", "verbose"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

// Each transport owns its own complete format chain (including whether to colorize) - do NOT
// also set a `format` on the logger itself. Winston applies the logger-level format before
// handing off to transports, so a shared `colorize()` there bakes ANSI codes into `info.level`
// for every transport, including file ones that never asked for color (this bit us once already).
const consoleTransport = new winston.transports.Console({
	level: process.env.CONSOLE_LOG_LEVEL ?? "info",
	format: combine(commonFormat, colorize({ all: true }), logFormat),
});

// Rotation knobs, shared by both rotated files below.
const LOG_RETENTION_DAYS = process.env.LOG_RETENTION_DAYS ?? "14";
// Optional extra rotation trigger by size (e.g. "20m") - unset means date-based rotation only.
const LOG_MAX_SIZE = process.env.LOG_MAX_SIZE;

// Full detail (whatever `shared.level` allows), dated files - the place to look for verbose/debug
// traces after the fact.
const combinedFileTransport = new DailyRotateFile({
	filename: "logs/combined-%DATE%.log",
	datePattern: "YYYY-MM-DD",
	maxFiles: `${LOG_RETENTION_DAYS}d`,
	maxSize: LOG_MAX_SIZE,
	format: plainFormat,
});

const shared = winston.createLogger({
	levels: customLevels.levels,
	// Governs what reaches `combinedFileTransport` (debug by default - full detail, but NOT the
	// even-noisier `verbose` tier; bump to "verbose" to also capture macro/biome parsing traces).
	// The console has its own, quieter level above.
	level: process.env.LOG_LEVEL ?? "debug",
	transports: [
		// Console stays quiet by default - debug-level noise (macro/biome parsing traces) never
		// shows up here, only in the rotated file below.
		consoleTransport,
		combinedFileTransport,
		// Errors only, same rotation - a quick "did anything critical happen" check without
		// wading through debug noise. Deliberately not exposed to `setLogLevel` - this file's
		// whole point is "errors only", always.
		new DailyRotateFile({
			filename: "logs/error-%DATE%.log",
			datePattern: "YYYY-MM-DD",
			maxFiles: `${LOG_RETENTION_DAYS}d`,
			maxSize: LOG_MAX_SIZE,
			level: "error",
			format: plainFormat,
		}),
	],
});

/** Changes the console's or the combined file's minimum log level at runtime - no restart needed. */
export function setLogLevel(target: "console" | "file", level: LogLevel): void {
	if (target === "console") consoleTransport.level = level;
	else shared.level = level;
}

export function getLogLevels(): { console: string; file: string } {
	return { console: consoleTransport.level ?? "info", file: shared.level };
}

export class Logger {
	private readonly child: winston.Logger;

	constructor(namespace: string) {
		this.child = shared.child({ namespace });
	}

	info(message: string, meta?: object): void {
		this.child.info(message, meta);
	}

	warn(message: string, meta?: object): void {
		this.child.warn(message, meta);
	}

	error(message: string | Error, meta?: object): void {
		if (message instanceof Error) {
			this.child.error(message.message, { stack: message.stack, ...meta });
		} else {
			this.child.error(message, meta);
		}
	}

	debug(message: string, meta?: object): void {
		this.child.debug(message, meta);
	}

	/** Below `debug` - for the noisy stuff (macro/biome parsing traces) you only want when actively digging in. */
	verbose(message: string, meta?: object): void {
		this.child.log("verbose", message, meta);
	}

	static stringify(value: unknown): string {
		return JSON.stringify(value, (_, v) =>
			typeof v === 'bigint' ? v.toString() : v, 2,
		);
	}
}
