import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import { loadCog, unloadCog, reloadCog } from "@/core/CogLoader";
import { registerSlashCommands } from "@/core/CommandHandler";
import { getPoolStats } from "@/database/connection";
import { join } from "path";
import { getLogLevels, LOG_LEVELS, Logger, setLogLevel, type LogLevel } from "@/utils/logging";
import { getEventLoopLag, getLastTickStats } from "@/utils/metrics";

const logger = new Logger("admin.commands.bot");
const COGS_PATH = join(__dirname, "../../");

export default defineCommand({
    name: "bot",
    description: "Bot administration.",
    category: CommandCategory.ADMIN,

    botOwnerOnly: true,
    showOnHelp: false,

    options: new SlashCommandBuilder()
        .addSubcommandGroup((g) =>
            g.setName("mod").setDescription("Cog management.")
                .addSubcommand((s) =>
                    s.setName("load").setDescription("Load a cog.")
                        .addStringOption((o) => o.setName("name").setDescription("Cog name").setRequired(true)),
                )
                .addSubcommand((s) =>
                    s.setName("unload").setDescription("Unload a cog.")
                        .addStringOption((o) => o.setName("name").setDescription("Cog name").setRequired(true)),
                )
                .addSubcommand((s) =>
                    s.setName("reload").setDescription("Restart a cog.")
                        .addStringOption((o) => o.setName("name").setDescription("Cog name").setRequired(true)),
                ),
        )
        .addSubcommandGroup((g) =>
            g.setName("log").setDescription("Runtime log level control.")
                .addSubcommand((s) =>
                    s.setName("set").setDescription("Change the console's or the log file's minimum level - no restart needed.")
                        .addStringOption((o) =>
                            o.setName("level").setDescription("Minimum level to show/capture").setRequired(true)
                                .addChoices(...LOG_LEVELS.map((l) => ({ name: l, value: l }))),
                        )
                        .addStringOption((o) =>
                            o.setName("target").setDescription("Where to apply it (default: console)")
                                .addChoices({ name: "Console", value: "console" }, { name: "File (logs/combined-*.log)", value: "file" }),
                        ),
                )
                .addSubcommand((s) => s.setName("show").setDescription("Show the current console/file log levels.")),
        )
        .addSubcommand((sub) =>
            sub.setName("sync").setDescription("Sync slash commands with Discord."),
        )
        .addSubcommand((sub) =>
            sub.setName("status").setDescription("Show bot status."),
        )
        .addSubcommand((sub) =>
            sub.setName("shutdown").setDescription("Shut down the bot gracefully."),
        ),

    // ── Slash ─────────────────────────────────────────────────────────────────
    async executeAsSlash(interaction, client) {
        const group = interaction.options.getSubcommandGroup(false);
        const sub = interaction.options.getSubcommand(true);
        const routeKey = group ? `${group}-${sub}` : sub;
        await interaction.deferReply({ ephemeral: true });

        try {
            const result = await runSubcommand(routeKey, {
                name: interaction.options.getString("name"),
                level: interaction.options.getString("level"),
                target: interaction.options.getString("target"),
            }, client);
            await interaction.editReply({ embeds: [successEmbed(result)] });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(err instanceof Error ? err : new Error(msg));
            await interaction.editReply({ embeds: [errorEmbed(msg)] });
        }
    },

    // ── Prefix ────────────────────────────────────────────────────────────────
    async executeAsPrefix(message, args, client) {
        const group = args.getSubcommandGroup();
        const sub = args.getSubcommand();
        if (!sub) {
            await message.reply({ embeds: [usageEmbed()] });
            return;
        }
        const routeKey = group ? `${group}-${sub}` : sub;

        try {
            const result = await runSubcommand(routeKey, {
                name: args.getString("name"),
                level: args.getString("level"),
                target: args.getString("target"),
            }, client);
            await message.reply({ embeds: [successEmbed(result)] });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(err instanceof Error ? err : new Error(msg));
            await message.reply({ embeds: [errorEmbed(msg)] });
        }
    },
});

// ─── Shared logic ─────────────────────────────────────────────────────────────

interface SubcommandArgs {
    name: string | null;
    level: string | null;
    target: string | null;
}

async function runSubcommand(
    sub: string,
    { name, level, target }: SubcommandArgs,
    client: import("@/core/BotClient").BotClient,
): Promise<string> {
    switch (sub) {
        case "mod-load":
            if (!name) throw new Error("Cog name required.");
            await loadCog(client, COGS_PATH, name);
            return `Cog \`${name}\` loaded.`;

        case "mod-unload":
            if (!name) throw new Error("Cog name required.");
            await unloadCog(client, name);
            return `Cog \`${name}\` unloaded.`;

        case "mod-reload":
            if (!name) throw new Error("Cog name required.");
            await reloadCog(client, COGS_PATH, name);
            return `Cog \`${name}\` restarted.`;

        case "log-set": {
            if (!level || !(LOG_LEVELS as readonly string[]).includes(level)) {
                throw new Error(`Level must be one of: ${LOG_LEVELS.join(", ")}`);
            }
            const resolvedTarget = target === "file" ? "file" : "console";
            setLogLevel(resolvedTarget, level as LogLevel);
            return `Log level for **${resolvedTarget}** set to \`${level}\` (runtime only - reverts on restart).`;
        }

        case "log-show": {
            const levels = getLogLevels();
            return `**Console:** \`${levels.console}\`\n**File (logs/combined-*.log):** \`${levels.file}\``;
        }

        case "sync": {
            const guildId = process.env.NODE_ENV === "development"
                ? process.env.DEV_GUILD_ID
                : undefined;
            await registerSlashCommands(client, guildId);
            return `Slash command tree synced (${client.commands.size} commands).`;
        }

        case "status": {
            const mem = process.memoryUsage();
            const pool = getPoolStats();
            const eventLoop = getEventLoopLag();
            const lastTick = getLastTickStats();

            const lines = [
                `**Uptime:** ${formatUptime(process.uptime())}`,
                `**Cogs:** ${client.cogs.size}`,
                `**Commands:** ${client.commands.size}`,
                `**Guilds:** ${client.guilds.cache.size}`,
                `**Ping:** ${client.ws.ping}ms`,
                `**Memory:** ${formatMb(mem.rss)} RSS, ${formatMb(mem.heapUsed)}/${formatMb(mem.heapTotal)} heap`,
                "",
                `- DB pool: ${pool.total} total, ${pool.idle} idle, ${pool.waiting} waiting${pool.waiting > 0 ? " ⚠️" : ""}`,
                `- Event loop lag: ${eventLoop.meanMs}ms mean, ${eventLoop.maxMs}ms max${eventLoop.maxMs > 100 ? " ⚠️" : ""}`,
                lastTick
                    ? `- Last activity sweep: ${lastTick.durationMs}ms for ${lastTick.userCount} user(s), <t:${Math.floor(lastTick.ranAt.getTime() / 1000)}:R>`
                    : "- Last activity sweep: none yet",
            ];
            return lines.join("\n");
        }

        case "shutdown":
            setTimeout(() => process.emit("SIGTERM"), 500);
            return "Shutting down... 👋";

        default:
            throw new Error(`Unknown subcommand: ${sub}`);
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function usageEmbed(): EmbedBuilder {
    return new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("🤖 Bot Administration")
        .addFields([
            {
                name: "Cog management",
                value: "`!bot mod load <name>`\n`!bot mod unload <name>`\n`!bot mod reload <name>`",
            },
            {
                name: "Bot",
                value: "`!bot sync` - sync slash commands\n`!bot status` - bot info\n`!bot shutdown` - graceful shutdown",
            },
            {
                name: "Logging",
                value: "`!bot log set <level> [target]` - change console/file log level (runtime only)\n`!bot log show` - show current levels",
            },
        ]);
}

function formatMb(bytes: number): string {
    return `${Math.round(bytes / 1024 / 1024)}MB`;
}

function successEmbed(msg: string): EmbedBuilder {
    return new EmbedBuilder().setColor(0x57f287).setDescription(`✅ ${msg}`);
}

function errorEmbed(msg: string): EmbedBuilder {
    return new EmbedBuilder().setColor(0xff0000).setDescription(`❌ ${msg}`);
}

function formatUptime(seconds: number): string {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return [d && `${d}d`, h && `${h}h`, m && `${m}m`, `${s}s`].filter(Boolean).join(" ");
}
