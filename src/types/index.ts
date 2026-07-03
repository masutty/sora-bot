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
import type { CommandContext } from "../core/context";

export type {
	ArgHelper,
	ArgType,
	CommandArg,
	CommandContext,
	ReplyPayload,
	SentMessage,
} from "../core/context";

// ─── Command Definition ────────────────────────────────────────────────────────

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
	args?: import("../core/context").CommandArg[];

	// Slash builder for advanced customisation (choices, autocomplete, maxLength…)
	slashBuilder?:
		| SlashCommandBuilder
		| SlashCommandSubcommandsOnlyBuilder
		| SlashCommandOptionsOnlyBuilder;

	// ── Restrictions ──────────────────────────────────────────────────────────────
	ownerOnly?: boolean;
	adminOnly?: boolean;
	permissions?: PermissionResolvable[];
	allowedUsers?: string[];

	// ── Unified handler (new API) ─────────────────────────────────────────────────
	execute?: (ctx: CommandContext) => Promise<void>;

	// ── Legacy handlers (kept for compatibility) ──────────────────────────────────
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

// ─── Module Definition ─────────────────────────────────────────────────────────

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

// ─── Guild Configuration ───────────────────────────────────────────────────────

export interface GuildConfig {
	id: string;
	prefix: string;
	settings: Record<string, unknown>;
	created_at: Date;
	updated_at: Date;
}

// ─── Command Registry interface ────────────────────────────────────────────────

export interface CommandRegistry {
	get(name: string): CommandDefinition | undefined;
	set(name: string, command: CommandDefinition): void;
	getAll(): CommandDefinition[];
}
