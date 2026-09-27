import type {
    AutocompleteInteraction,
    ChatInputCommandInteraction,
    ClientEvents,
    Message,
    PermissionResolvable,
    SlashCommandBuilder,
    SlashCommandOptionsOnlyBuilder,
    SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";
import type { BotClient } from "../core/bot-client";
import type { CommandContext, GuildCommandContext } from "../core/command/command-context";
import type { PrefixArgs } from "../core/command/prefix-args";
import type { WorkerDefinition } from "../core/worker/worker";

export { PrefixArgs } from "../core/command/prefix-args";

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

/** Where a command (or one subcommand) can be invoked. */
export type CommandModes = "both" | "slash" | "prefix";

/**
 * A command, declared with `defineCommand`. Write ONE `run(ctx)` - it serves both slash and
 * prefix through `CommandContext` (`ctx.args`, `ctx.reply`, `ctx.defer`). The framework handles,
 * before `run` is called: guild-only, guards, prefix usage for a missing/unknown subcommand, and
 * `modes`. After: a thrown `UserFacingError` is shown verbatim; anything else is logged + a quip.
 *
 * Precedence: `executeAsSlash`/`executeAsPrefix`, when present, replace `run` in THAT mode only -
 * an escape hatch for the rare truly different flow. Prefer `modes`/`subcommandModes`, or
 * `ctx.raw`, over overriding.
 */
export interface CommandDefinitionBase {
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

    /** Where the command exists at all. Default "both". "prefix" = never registered as a slash command. */
    modes?: CommandModes;

    /**
     * Per-subcommand `modes`, keyed `"sub"`, `"group"` (applies to every sub in it) or `"group:sub"`
     * (most specific wins). A "prefix" subcommand is stripped from the slash registration; a "slash"
     * one answers prefix callers with "only available as a slash command".
     */
    subcommandModes?: Record<string, CommandModes>;

    /**
     * Prefix invoked with no or an unknown subcommand: "usage" (default) replies with the
     * auto-generated usage and never calls `run`; "run" calls `run` anyway, with
     * `ctx.args.getSubcommand() === null` (and `getSubcommandGroup()` set for a bare group).
     */
    onMissingSubcommand?: "usage" | "run";

    /**
     * Autocomplete handler - called while the user types in an option with
     * `.setAutocomplete(true)` (e.g. an option whose choices come from an external API, so they
     * can't be fixed via `.addChoices()` at registration time). Without a handler, that option
     * never suggests anything.
     */
    executeAutocomplete?: (
        interaction: AutocompleteInteraction,
        client: BotClient,
    ) => Promise<void>;
}

/**
 * `guildOnly: true` -> registered for guilds only (hidden in DMs), a DM call is refused, and `run`
 * gets a `GuildCommandContext` (non-null `guild`/`member`).
 */
export type CommandDefinition = CommandDefinitionBase & (
    | { guildOnly: true; run?: (ctx: GuildCommandContext) => Promise<void> }
    | { guildOnly?: false; run?: (ctx: CommandContext) => Promise<void> }
);

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
    /** Periodic background tasks - the framework starts each one on load, stops on unload/hot reload. */
    workers?: WorkerDefinition[];
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
