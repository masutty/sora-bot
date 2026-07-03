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
import type { PrefixArgs } from "../core/PrefixArgs";

export { PrefixArgs } from "../core/PrefixArgs";

// ─── Enums ────────────────────────────────────────────────────────────────────

export enum CommandCategory {
    GENERAL = "GENERAL",
    ADMIN = "ADMIN",
    MODERATION = "MODERATION",
    FUN = "FUN",
    UTILITY = "UTILITY",
    MUSIC = "MUSIC",
    ECONOMY = "ECONOMY",
}

// ─── Command Definition ───────────────────────────────────────────────────────

export interface CommandDefinition {
    name: string;
    description: string;
    category?: CommandCategory;

    /**
     * Full SlashCommandBuilder — used for slash registration.
     * For prefix commands, arg names are derived from this builder's options.
     */
    options?:
    | SlashCommandBuilder
    | SlashCommandOptionsOnlyBuilder
    | SlashCommandSubcommandsOnlyBuilder;

    /** Whether this command appears in !help */
    showOnHelp?: boolean;

    // ── Restrictions ──────────────────────────────────────────────────────────
    botOwnerOnly?: boolean;
    adminOnly?: boolean;
    permissions?: PermissionResolvable[];
    allowedUsers?: string[];

    // ── Handlers ──────────────────────────────────────────────────────────────

    /**
     * Slash command handler.
     * Receives the raw discord.js interaction — full type safety, no wrapper.
     */
    executeAsSlash?: (
        interaction: ChatInputCommandInteraction,
        client: BotClient,
    ) => Promise<void>;

    /**
     * Prefix command handler.
     * Receives the raw Message plus a PrefixArgs helper derived from the builder schema.
     */
    executeAsPrefix?: (
        message: Message,
        args: PrefixArgs,
        client: BotClient,
    ) => Promise<void>;

    /**
     * Convenience alias — runs as slash only.
     * Use this for simple commands that don't need prefix-specific handling.
     * Identical to executeAsSlash.
     */
    execute?: (
        interaction: ChatInputCommandInteraction,
        client: BotClient,
    ) => Promise<void>;
}

// ─── Cog (replaces ModuleDefinition) ─────────────────────────────────────────

export interface CogAuthor {
    name: string;
    id: bigint;
}

/**
 * A Cog is a self-contained unit of bot functionality.
 * Each module folder exports a default Cog via `defineCog(...)`.
 */
export interface Cog {
    name: string;
    description: string;
    authors: CogAuthor[];
    commands?: CommandDefinition[];
    events?: {
        [K in keyof ClientEvents]?: (
            client: BotClient,
            ...args: ClientEvents[K]
        ) => void | Promise<void>;
    };
    /** SQL migration strings to run on load */
    migrations?: string[];
    start?: (client: BotClient) => void | Promise<void>;
    stop?: (client: BotClient) => void | Promise<void>;
    onReady?: (client: BotClient) => void | Promise<void>;
}

// ─── Registry interface ───────────────────────────────────────────────────────

export interface CommandRegistry {
    get(name: string): CommandDefinition | undefined;
    set(name: string, command: CommandDefinition): void;
    getAll(): CommandDefinition[];
}

export interface GuildConfig {
    id: string;
    prefix: string;
    settings: Record<string, unknown>;
    created_at: Date;
    updated_at: Date;
}
