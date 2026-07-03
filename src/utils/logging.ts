import winston from "winston";

const { combine, timestamp, printf, colorize, errors } = winston.format;

const LEVEL_WIDTH = 5; // longest used level: "error" / "debug"

const logFormat = printf(({ level, message, timestamp, namespace, stack }) => {
	// level is already colorized — strip ANSI to measure true display length
	const displayLen = level.replace(/\x1B\[[0-9;]*m/g, "").length;
	const padding = " ".repeat(Math.max(0, LEVEL_WIDTH - displayLen));
	const ns = namespace ? ` [${namespace}]` : "";
	const trace = stack ? `\n${stack}` : "";
	return `${timestamp} ${level}${padding}${ns}: ${message}${trace}`;
});

const shared = winston.createLogger({
	level: process.env.LOG_LEVEL ?? "info",
	format: combine(
		errors({ stack: true }),
		timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
		colorize({ all: true }),
		logFormat,
	),
	transports: [new winston.transports.Console()],
});

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

	static stringify(value: unknown): string {
		return JSON.stringify(value, (_, v) =>
			typeof v === 'bigint' ? v.toString() : v, 2,
		);
	}
}
