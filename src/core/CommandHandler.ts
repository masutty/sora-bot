import {
    type ChatInputCommandInteraction,
    EmbedBuilder,
    Events,
    type Message,
    REST,
    Routes,
    SlashCommandBuilder,
} from "discord.js";
import { Logger } from "@/utils/logging";
import { config } from "../config";
import { getGuildPrefix } from "../database/guildRepository";
import type { BotClient } from "./BotClient";
import { PrefixCommandContext, SlashCommandContext } from "./context";
import { checkGuards } from "./guards";
import type { CommandArg } from "../types";
import { getFailureQuip } from "@/utils/quips";

const logger = new Logger("Core.CommandHandler");
const slashLogger = new Logger("Core.SlashCmd");

// ─── Arg Derivation ────────────────────────────────────────────────────────────

type RawOption = {
    name: string;
    description: string;
    type: number;
    required?: boolean;
};

const OPTION_TYPE_MAP: Record<number, CommandArg["type"] | null> = {
    3: "string",
    4: "number",
    5: "boolean",
    6: "user",
    7: "channel",
    8: "role",
    10: "number",
};

function deriveArgsFromBuilder(
    builder: SlashCommandBuilder | { toJSON(): { options?: RawOption[] } },
): CommandArg[] {
    const json = builder.toJSON() as { options?: RawOption[] };
    if (!json.options?.length) return [];

    return json.options.flatMap((opt): CommandArg[] => {
        const type = OPTION_TYPE_MAP[opt.type];
        if (!type) return [];
        return [{ name: opt.name, description: opt.description, type, required: opt.required ?? false }];
    });
}

// ─── Arg Parser ────────────────────────────────────────────────────────────────

function parseArgs(input: string): string[] {
    const args: string[] = [];
    let current = "";
    let inQuotes = false;

    for (const char of input) {
        if (char === '"') {
            inQuotes = !inQuotes;
            continue;
        }
        if (char === " " && !inQuotes) {
            if (current.length) { args.push(current); current = ""; }
            continue;
        }
        current += char;
    }

    if (current.length) args.push(current);
    return args;
}

// ─── Command Handlers ──────────────────────────────────────────────────────────

export function registerCommandHandlers(client: BotClient): void {
    client.on(Events.MessageCreate, async (message: Message) => {
        if (message.author.bot || !message.guild) return;

        const prefix = await getGuildPrefix(message.guild.id);
        if (!message.content.startsWith(prefix)) return;

        const [commandName, ...args] = parseArgs(message.content.slice(prefix.length).trim());
        if (!commandName) return;

        const command = client.commands.get(commandName.toLowerCase());
        if (!command) return;

        if (command.prefixEnabled === false) return;

        // respeita setDefaultMemberPermissions no prefix
        const requiredPerms = command.options?.toJSON().default_member_permissions;
        if (requiredPerms && !message.member?.permissions.has(BigInt(requiredPerms))) {
            await message.reply({ embeds: [errorEmbed("You don't have permission to use this command.")] }).catch(() => { });
            return;
        }

        try {
            if (command.execute) {
                const schema = command.options ? deriveArgsFromBuilder(command.options) : [];
                const ctx = new PrefixCommandContext(message, args, schema, client);
                const guardError = await checkGuards(ctx, command);
                if (guardError) {
                    await ctx.reply({ embeds: [errorEmbed("Error! " + getFailureQuip() + "\n" + guardError)] });
                    return;
                }
                await command.execute(ctx);
            } else if (command.executePrefix) {
                await command.executePrefix(message, args, client);
            }
        } catch (err) {
            logger.error(err instanceof Error ? err : new Error(String(err)), { command: commandName });
            await message.reply({ embeds: [errorEmbed(getFailureQuip())] }).catch(() => { });
        }
    });

    client.on(Events.InteractionCreate, async (interaction) => {
        if (!interaction.isChatInputCommand()) return;

        const command = client.commands.get(interaction.commandName);
        if (!command) {
            await interaction.reply({ content: "Unknown command.", ephemeral: true });
            return;
        }

        try {
            if (command.execute) {
                const ctx = new SlashCommandContext(interaction as ChatInputCommandInteraction, client);
                const guardError = await checkGuards(ctx, command);
                if (guardError) {
                    await ctx.reply({ embeds: [errorEmbed(getFailureQuip() + "\n" + guardError)], ephemeral: true });
                    return;
                }
                await command.execute(ctx);
            } else if (command.executeSlash) {
                await command.executeSlash(interaction as ChatInputCommandInteraction, client);
            }
        } catch (err) {
            logger.error(err instanceof Error ? err : new Error(String(err)), { command: interaction.commandName });

            const payload = { embeds: [errorEmbed(getFailureQuip())], ephemeral: true };

            if (interaction.replied || interaction.deferred) {
                await interaction.followUp(payload).catch(() => { });
            } else {
                await interaction.reply(payload).catch(() => { });
            }
        }
    });
}

// ─── Slash Command Registration ────────────────────────────────────────────────

export async function registerSlashCommands(
    client: BotClient,
    guildId?: string,
): Promise<void> {
    const rest = new REST().setToken(config.discord.token);

    const builders = client.commands.getAll().map((cmd) => {
        if (cmd.options) return cmd.options.toJSON();
        return new SlashCommandBuilder().setName(cmd.name).setDescription(cmd.description).toJSON();
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function errorEmbed(msg: string): EmbedBuilder {
    return new EmbedBuilder().setColor(0xff0000).setDescription(`❌ ${msg}`);
}
