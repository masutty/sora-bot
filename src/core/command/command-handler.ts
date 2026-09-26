import {
    type ChatInputCommandInteraction,
    Events,
    type Message,
    REST,
    Routes,
} from "discord.js";
import { config } from "@/config";
import { getGuildPrefix } from "@/database/guild.repository";
import type { CommandDefinition } from "@/types";
import { Logger } from "@/utils/logging";
import { getFailureQuip } from "@/utils/quips";
import type { BotClient } from "../bot-client";
import { checkGuards } from "../guards";
import { type CommandContext, type CommandMode, createPrefixContext, createSlashContext, type ReplyPayload } from "./command-context";
import { buildSlashJson, effectiveMode, hasSubcommands, isAllowed, selectHandler, subcommandKey } from "./command-dispatch";
import { buildUsagePayload } from "./command-usage";
import { deriveSchema, deriveSubcommandSchema, PrefixArgs } from "./prefix-args";
import { describeCommandError, errorReply } from "./user-facing-error";

const logger = new Logger("core.commandhandlers");
const slashLogger = new Logger("core.slashcommands");

// ─── Arg parser ───────────────────────────────────────────────────────────────

function parseArgs(input: string): string[] {
    const args: string[] = [];
    let current = "";
    let inQuotes = false;

    for (const char of input) {
        if (char === '"') { inQuotes = !inQuotes; continue; }
        // Any whitespace splits a token, not just a literal space - otherwise a command followed
        // by a newline (e.g. "!request\n```json\n...") glues everything up to the first real
        // space, which can land in the middle of the payload (JSON indentation) instead of right
        // after the command name. The command is never found, and it fails silently.
        if (/\s/.test(char) && !inQuotes) {
            if (current.length) { args.push(current); current = ""; }
            continue;
        }
        current += char;
    }

    if (current.length) args.push(current);
    return args;
}

// ─── Shared dispatch ──────────────────────────────────────────────────────────

const GUILD_ONLY = "This command only works in a server.";

/** Everything after "the command was found" - identical for both modes, driven by command-dispatch's pure rules. */
async function dispatch(def: CommandDefinition, ctx: CommandContext, invoke: {
    guardFailure: (guardError: string) => ReplyPayload;
    override: () => Promise<void>;
    noHandler: () => Promise<void>;
}): Promise<void> {
    const { mode } = ctx;

    if (def.guildOnly && (!ctx.guild || !ctx.member)) {
        await ctx.reply(errorReply(GUILD_ONLY), { ephemeral: true });
        return;
    }

    const guardError = await checkGuards({ user: ctx.user, member: ctx.member }, def);
    if (guardError) {
        await ctx.reply(invoke.guardFailure(guardError), { ephemeral: true });
        return;
    }

    const group = ctx.args.getSubcommandGroup();
    const sub = ctx.args.getSubcommand();
    if (mode === "prefix" && !sub && hasSubcommands(def) && def.onMissingSubcommand !== "run") {
        await ctx.replyUsage();
        return;
    }

    const key = subcommandKey(group, sub);
    if (!isAllowed(def, mode, key)) {
        const path = [def.name, group, sub].filter(Boolean).join(" ");
        const where = mode === "prefix"
            ? `a slash command: \`/${path}\``
            : `a prefix command: \`${ctx.guild ? await getGuildPrefix(ctx.guild.id) : config.bot.defaultPrefix}${path}\``;
        await ctx.reply(errorReply(`This command is only available as ${where}.`), { ephemeral: true });
        return;
    }

    const handler = selectHandler(def, mode);
    if (handler.kind === "run") {
        // guildOnly was checked above, so a GuildCommandContext is guaranteed when the def asks for one.
        await (def.run as (ctx: CommandContext) => Promise<void>)(ctx);
    } else if (handler.kind === "none") {
        await invoke.noHandler();
    } else {
        await invoke.override();
    }
}

/** Usage for `mode`, with the framework's flag-style setting (prefix only). */
function usageFor(def: CommandDefinition, invokePrefix: string, group: string | null, mode: CommandMode): ReplyPayload | null {
    return buildUsagePayload(def, invokePrefix, group, mode, mode === "prefix" && config.bot.allowArgsAsFlags);
}

/** A failure after dispatch started: UserFacingError -> its message; anything else -> logged + quip. */
async function reportFailure(err: unknown, commandName: string, reply: (payload: ReplyPayload) => Promise<unknown>): Promise<void> {
    const view = describeCommandError(err);
    if (view.kind === "user") {
        await reply(errorReply(view.message)).catch(() => { });
        return;
    }
    logger.error(err instanceof Error ? err : new Error(String(err)), { command: commandName });
    await reply(errorReply(getFailureQuip())).catch(() => { });
}

// ─── Command Handlers ─────────────────────────────────────────────────────────

export function registerCommandHandlers(client: BotClient): void {

    // ── Prefix ────────────────────────────────────────────────────────────────
    client.on(Events.MessageCreate, async (message: Message) => {
        if (message.author.bot || !message.guild) return;

        const prefix = await getGuildPrefix(message.guild.id);
        if (!message.content.startsWith(prefix)) return;

        const [commandName, ...rawArgs] = parseArgs(message.content.slice(prefix.length).trim());
        if (!commandName) return;

        const command = client.commands.get(commandName.toLowerCase());
        if (!command) return;
        // A slash-only command doesn't exist on prefix at all - ignored like an unknown name.
        if (effectiveMode(command, null) === "slash") return;
        if (selectHandler(command, "prefix").kind === "none") return; // Command doesn't support prefix

        const schema = command.options ? deriveSchema(command.options) : [];
        const subcommandMap = command.options ? deriveSubcommandSchema(command.options) : undefined;
        const args = new PrefixArgs(rawArgs, schema, message.guild, client, subcommandMap);
        const ctx: CommandContext = createPrefixContext(message, args, client, prefix, {
            usage: () => usageFor(command, prefix, args.getSubcommandGroup(), "prefix"),
        });

        try {
            await dispatch(command, ctx, {
                guardFailure: (guardError) => errorReply(`Error! ${getFailureQuip()}\n${guardError}`),
                override: () => (command.executeAsPrefix as NonNullable<typeof command.executeAsPrefix>)(message, args, client),
                noHandler: async () => { },
            });
        } catch (err) {
            await reportFailure(err, commandName, (payload) => ctx.reply(payload, { ephemeral: true }));
        }
    });

    // ── Autocomplete ──────────────────────────────────────────────────────────
    client.on(Events.InteractionCreate, async (interaction) => {
        if (!interaction.isAutocomplete()) return;

        const command = client.commands.get(interaction.commandName);
        const handler = command?.executeAutocomplete;
        if (!handler) return;

        try {
            await handler(interaction, client);
        } catch (err) {
            logger.error(err instanceof Error ? err : new Error(String(err)), { command: interaction.commandName });
            await interaction.respond([]).catch(() => { });
        }
    });

    // ── Slash ─────────────────────────────────────────────────────────────────
    client.on(Events.InteractionCreate, async (interaction) => {
        if (!interaction.isChatInputCommand()) return;

        const command = client.commands.get(interaction.commandName);
        if (!command) {
            await interaction.reply({ content: "Unknown command.", ephemeral: true });
            return;
        }

        const slash = interaction as ChatInputCommandInteraction;
        const ctx: CommandContext = createSlashContext(slash, client, {
            usage: () => usageFor(command, "/", slash.options.getSubcommandGroup(false), "slash"),
        });
        const overrode = selectHandler(command, "slash").kind === "override-slash";

        try {
            await dispatch(command, ctx, {
                guardFailure: (guardError) => errorReply(`${getFailureQuip()}\n${guardError}`),
                override: () => (command.executeAsSlash as NonNullable<typeof command.executeAsSlash>)(interaction as ChatInputCommandInteraction, client),
                noHandler: async () => {
                    await interaction.reply({ content: "This command is not available as a slash command.", ephemeral: true });
                },
            });
        } catch (err) {
            // An override replies on the raw interaction, so ctx doesn't know its state - pick the call from the interaction itself.
            const reply = overrode
                ? (payload: ReplyPayload) => {
                    const body = { ...(typeof payload === "string" ? { content: payload } : payload), ephemeral: true };
                    return interaction.replied || interaction.deferred ? interaction.followUp(body) : interaction.reply(body);
                }
                : (payload: ReplyPayload) => ctx.reply(payload, { ephemeral: true });
            await reportFailure(err, interaction.commandName, reply);
        }
    });
}

// ─── Slash Registration ───────────────────────────────────────────────────────

export async function registerSlashCommands(
    client: BotClient,
    guildId?: string,
): Promise<void> {
    const rest = new REST().setToken(config.discord.token);

    const builders = client.commands.getAll().flatMap((cmd) => {
        const json = buildSlashJson(cmd);
        return json ? [json] : [];
    });

    try {
        const route = guildId
            ? Routes.applicationGuildCommands(config.discord.clientId, guildId)
            : Routes.applicationCommands(config.discord.clientId);

        await rest.put(route, { body: builders });
        slashLogger.info(`${builders.length} commands registered ${guildId ? `in guild ${guildId}` : "globally"}.`);
    } catch (err) {
        slashLogger.error(err instanceof Error ? err : new Error(String(err)));
        throw err;
    }
}
