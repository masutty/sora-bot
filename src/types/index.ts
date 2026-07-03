import type {
	ChatInputCommandInteraction,
	ClientEvents,
	Message,
	PermissionResolvable,
	SlashCommandBuilder,
	SlashCommandOptionsOnlyBuilder,
	SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";
import type { BotClient } from "../core/BotClient";
import type { CommandContext, CommandArg } from "../core/context";

export type {
	ArgHelper,
	ArgType,
	CommandArg,
	CommandContext,
	ReplyPayload,
	SentMessage,
} from "../core/context";

export enum CommandCategory {
	GENERAL = "GENERAL",
	ADMIN = "ADMIN",
	MODERATION = "MODERATION",
	FUN = "FUN",
	UTILITY = "UTILITY",
	MUSIC = "MUSIC",
	ECONOMY = "ECONOMY",
}

export interface CommandDefinition {
	name: string;
	description: string;
	category?: CommandCategory;

	/** Full SlashCommandBuilder — used for slash registration and prefix arg derivation */
	options?:
		| SlashCommandBuilder
		| SlashCommandOptionsOnlyBuilder
		| SlashCommandSubcommandsOnlyBuilder;

	/** Whether this command can be invoked via prefix (default: true) */
	prefixEnabled?: boolean;

	/** Whether this command appears in !help (default: true) */
	hidden?: boolean;

	// ── Restrictions ─────────────────────────────────────────────────────────
	ownerOnly?: boolean;
	adminOnly?: boolean;
	permissions?: PermissionResolvable[];
	allowedUsers?: string[];

	// ── Unified handler ───────────────────────────────────────────────────────
	execute?: (ctx: CommandContext) => Promise<void>;

	// ── Legacy handlers ───────────────────────────────────────────────────────
	executeSlash?: (
		interaction: ChatInputCommandInteraction,
		client: BotClient,
	) => Promise<void>;
	executePrefix?: (
		message: Message,
		args: string[],
		client: BotClient,
	) => Promise<void>;
}

export interface ModuleAuthor {
	name: string;
	id: bigint;
}

export interface ModuleDefinition {
	name: string;
	description: string;
	authors: ModuleAuthor[];
	commands?: CommandDefinition[];
	events?: {
		[K in keyof ClientEvents]?: (client: BotClient, ...args: ClientEvents[K]) => void | Promise<void>;
	};
	migrations?: string[];
	start?: (client: BotClient) => void | Promise<void>;
	stop?: (client: BotClient) => void | Promise<void>;
	onReady?: (client: BotClient) => void | Promise<void>;
}

export interface GuildConfig {
	id: string;
	prefix: string;
	settings: Record<string, unknown>;
	created_at: Date;
	updated_at: Date;
}

export interface CommandRegistry {
	get(name: string): CommandDefinition | undefined;
	set(name: string, command: CommandDefinition): void;
	getAll(): CommandDefinition[];
}
