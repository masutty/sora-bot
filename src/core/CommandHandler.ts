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
import { config } from "@/config";
import { getGuildPrefix } from "@/database/guildRepository";
import type { BotClient } from "./BotClient";
import { PrefixArgs, deriveSchema, deriveSubcommandSchema } from "./PrefixArgs";
import { checkGuards } from "./guards";
import { getFailureQuip } from "@/utils/quips";
import type { CommandDefinition } from "@/types";
import { GuildMember } from "discord.js";

const logger = new Logger("core.commandhandlers");
const slashLogger = new Logger("core.slashcommands");

// ─── Arg parser ───────────────────────────────────────────────────────────────

function parseArgs(input: string): string[] {
    const args: string[] = [];
    let current = "";
    let inQuotes = false;

    for (const char of input) {
        if (char === '"') { inQuotes = !inQuotes; continue; }
        if (char === " " && !inQuotes) {
            if (current.length) { args.push(current); current = ""; }
            continue;
        }
        current += char;
    }

    if (current.length) args.push(current);
    return args;
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

        const handler = command.executeAsPrefix;
        if (!handler) return; // Command doesn't support prefix

        const schema = command.options ? deriveSchema(command.options) : [];
        const subcommandMap = command.options ? deriveSubcommandSchema(command.options) : undefined;
        const args = new PrefixArgs(rawArgs, schema, message.guild, client, subcommandMap);

        try {
            const guardError = await checkGuards({ user: message.author, member: message.member }, command);
            if (guardError) {
                await message.reply({ embeds: [errorEmbed("Error! " + getFailureQuip() + "\n" + guardError)] }).catch(() => { });
                return;
            }
            await handler(message, args, client);
        } catch (err) {
            logger.error(err instanceof Error ? err : new Error(String(err)), { command: commandName });
            await message.reply({ embeds: [errorEmbed(getFailureQuip())] }).catch(() => { });
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

        const handler = command.executeAsSlash;
        if (!handler) {
            await interaction.reply({ content: "This command is not available as a slash command.", ephemeral: true });
            return;
        }

        try {
            const guardError = await checkGuards(
                { user: interaction.user, member: interaction.member as GuildMember | null },
                command,
            );
            if (guardError) {
                const payload = { embeds: [errorEmbed(getFailureQuip() + "\n" + guardError)], ephemeral: true };
                await interaction.reply(payload).catch(() => { });
                return;
            }
            await handler(interaction as ChatInputCommandInteraction, client);
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

// ─── Slash Registration ───────────────────────────────────────────────────────

export async function registerSlashCommands(
    client: BotClient,
    guildId?: string,
): Promise<void> {
    const rest = new REST().setToken(config.discord.token);

    const builders = client.commands.getAll().map((cmd) => {
        if (cmd.options) return cmd.options.toJSON();
        return new SlashCommandBuilder()
            .setName(cmd.name)
            .setDescription(cmd.description)
            .toJSON();
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
