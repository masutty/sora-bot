import { ContainerBuilder, MessageFlags, OAuth2Scopes, PermissionFlagsBits, SeparatorSpacingSize, SlashCommandBuilder } from "discord.js";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import { loadCog, unloadCog, reloadCog, hotReloadBot } from "@/core/CogLoader";
import { registerSlashCommands } from "@/core/CommandHandler";
import type { BotClient } from "@/core/BotClient";
import { config } from "@/config";
import { getPoolStats, query } from "@/database/connection";
import { join } from "path";
import { EmbedFormatter } from "@/utils/format";
import { getLogLevels, LOG_LEVELS, Logger, setLogLevel, type LogLevel } from "@/utils/logging";
import { getEventLoopLag, getEventLoopLagDetail, getLastTickStats } from "@/utils/metrics";

const logger = new Logger("admin.commands.bot");
const COGS_PATH = join(__dirname, "../../");

// Pure-read subcommands (as opposed to reload-all/log-set/sync/shutdown, which change state) -
// these get a neutral embed instead of a green success checkmark, since nothing was "done".
const READONLY_SUBCOMMANDS = new Set(["commands", "servers", "ping", "memory", "db", "event-loop", "uptime", "invite"]);

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
            sub.setName("reload-all").setDescription("Hot reloads the entire bot - picks up code changes in any file, no restart needed."),
        )
        .addSubcommand((sub) =>
            sub.setName("sync").setDescription("Sync slash commands with Discord."),
        )
        .addSubcommand((sub) =>
            sub.setName("status").setDescription("Show bot status."),
        )
        .addSubcommand((sub) =>
            sub.setName("shutdown").setDescription("Shut down the bot gracefully."),
        )
        .addSubcommand((sub) => sub.setName("uptime").setDescription("Shows how long the process has been running."))
        .addSubcommand((sub) => sub.setName("invite").setDescription("Generates the bot's invite link (with Administrator permission)."))
        .addSubcommand((sub) => sub.setName("commands").setDescription("Lists registered commands, grouped by cog."))
        .addSubcommand((sub) => sub.setName("servers").setDescription("Lists the servers the bot is in."))
        .addSubcommand((sub) => sub.setName("ping").setDescription("WebSocket and database latency."))
        .addSubcommand((sub) => sub.setName("memory").setDescription("Detailed process memory and CPU usage."))
        .addSubcommand((sub) => sub.setName("db").setDescription("Connection pool detail."))
        .addSubcommand((sub) => sub.setName("event-loop").setDescription("Event-loop lag detail (percentiles).")),

    // ── Slash ─────────────────────────────────────────────────────────────────
    async executeAsSlash(interaction, client) {
        const group = interaction.options.getSubcommandGroup(false);
        const sub = interaction.options.getSubcommand(true);
        const routeKey = group ? `${group}-${sub}` : sub;

        // ComponentsV2 can't coexist with embed/content in the same message - own reply, outside
        // the generic string -> EmbedFormatter pipeline used by the rest of the subcommands.
        if (routeKey === "status") {
            await interaction.reply({
                flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
                components: [buildStatusContainer(client)],
            });
            return;
        }

        await interaction.deferReply({ ephemeral: true });

        try {
            const result = await runSubcommand(routeKey, {
                name: interaction.options.getString("name"),
                level: interaction.options.getString("level"),
                target: interaction.options.getString("target"),
            }, client);
            const formatted = READONLY_SUBCOMMANDS.has(routeKey) ? EmbedFormatter.plain(result) : EmbedFormatter.success(result);
            await interaction.editReply(formatted);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(err instanceof Error ? err : new Error(msg));
            await interaction.editReply(EmbedFormatter.error(msg));
        }
    },

    // ── Prefix ────────────────────────────────────────────────────────────────
    async executeAsPrefix(message, args, client) {
        const group = args.getSubcommandGroup();
        const sub = args.getSubcommand();
        if (!sub) {
            await message.reply({ flags: MessageFlags.IsComponentsV2, components: [usageContainer()] });
            return;
        }
        const routeKey = group ? `${group}-${sub}` : sub;

        logger.info(`Executing ${routeKey} command...`);

        const BLOCKED_AS_PREFIX = ['db', 'event-loop', 'uptime', 'invite', 'commands', 'servers', 'ping', 'memory']
        if (BLOCKED_AS_PREFIX.includes(routeKey)) {
            await message.reply(EmbedFormatter.error("I cannot run that as prefix! Use slash instead."));
            return;
        }

        if (routeKey === "status") {
            await message.reply({ flags: MessageFlags.IsComponentsV2, components: [buildStatusContainer(client)] });
            return;
        }

        try {
            const result = await runSubcommand(routeKey, {
                name: args.getString("name"),
                level: args.getString("level"),
                target: args.getString("target"),
            }, client);
            const formatted = READONLY_SUBCOMMANDS.has(routeKey) ? EmbedFormatter.plain(result) : EmbedFormatter.success(result);
            await message.reply(formatted);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(err instanceof Error ? err : new Error(msg));
            await message.reply(EmbedFormatter.error(msg));
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
    client: BotClient,
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

        case "reload-all": {
            const failures = await hotReloadBot(client, COGS_PATH);
            const summary = `Bot reloaded: ${client.cogs.size} cog(s), ${client.commands.size} command(s).`;
            // hotReloadBot doesn't abort the whole reload if ONE cog fails (same resilience as
            // boot) - but here, unlike boot, someone's waiting on a response: reporting success
            // when a cog got left behind would be a lie. Turns into an error even though the rest
            // reloaded fine.
            if (failures.length) {
                throw new Error(`${summary}\n⚠️ Failed to load: ${failures.map((f) => `\`${f.cog}\` (${f.error})`).join(", ")}`);
            }
            return summary;
        }

        case "sync": {
            const guildId = process.env.NODE_ENV === "development"
                ? process.env.DEV_GUILD_ID
                : undefined;
            await registerSlashCommands(client, guildId);
            return `Slash command tree synced (${client.commands.size} commands).`;
        }

        case "shutdown":
            setTimeout(() => process.emit("SIGTERM"), 500);
            return "Shutting down... 👋";

        case "uptime":
            return `Uptime: ${formatUptime(process.uptime())}`;

        // Administrator because the bot already runs with that trust level in this Discord server
        // (guards.ts already treats Administrator as the "admin" gate everywhere else) - avoids
        // keeping a fine-grained permission list in sync every time a new cog wants a new scope.
        case "invite":
            return client.generateInvite({
                scopes: [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands],
                permissions: PermissionFlagsBits.Administrator,
            });

        case "commands": {
            const lines = [...client.cogs.values()].map(
                (c) => `**${c.name}** (${c.commands?.length ?? 0}): ${c.commands?.map((cmd) => `\`${cmd.name}\``).join(", ") || "-"}`,
            );
            return [`**Total:** ${client.commands.size} command(s)`, "", ...lines].join("\n");
        }

        case "servers": {
            const guilds = [...client.guilds.cache.values()];
            const shown = guilds.slice(0, 20).map((g) => `- **${g.name}** (\`${g.id}\`) - ${g.memberCount} member(s)`);
            const extra = guilds.length > 20 ? `\n... and ${guilds.length - 20} more` : "";
            return `${[`**Total:** ${guilds.length} server(s)`, "", ...shown].join("\n")}${extra}`;
        }

        case "ping": {
            const dbStart = Date.now();
            await query("SELECT 1");
            const dbMs = Date.now() - dbStart;
            return `**WebSocket:** ${client.ws.ping}ms\n**Database:** ${dbMs}ms (\`SELECT 1\`)`;
        }

        case "memory": {
            const mem = process.memoryUsage();
            const cpu = process.resourceUsage();
            return [
                `**RSS:** ${formatMb(mem.rss)}`,
                `**Heap:** ${formatMb(mem.heapUsed)} / ${formatMb(mem.heapTotal)}`,
                `**External:** ${formatMb(mem.external)}`,
                `**Array buffers:** ${formatMb(mem.arrayBuffers)}`,
                `**CPU (user/system):** ${Math.round(cpu.userCPUTime / 1000)}ms / ${Math.round(cpu.systemCPUTime / 1000)}ms`,
            ].join("\n");
        }

        case "db": {
            const pool = getPoolStats();
            return [
                `**Connections:** ${pool.total} total, ${pool.idle} idle, ${pool.waiting} waiting`,
                `**Config:** max ${config.database.poolMax}, idle timeout ${config.database.poolIdleTimeout}ms`,
                `**Target:** \`${config.database.user}@${config.database.host}:${config.database.port}/${config.database.database}\`${config.database.ssl ? " (SSL)" : ""}`,
            ].join("\n");
        }

        case "event-loop": {
            const d = getEventLoopLagDetail();
            return [
                `**Mean:** ${d.meanMs}ms`,
                `**Min / Max:** ${d.minMs}ms / ${d.maxMs}ms`,
                `**p50 / p95 / p99:** ${d.p50Ms}ms / ${d.p95Ms}ms / ${d.p99Ms}ms`,
                `**Std dev:** ${d.stddevMs}ms`,
            ].join("\n");
        }

        default:
            throw new Error(`Unknown subcommand: ${sub}`);
    }
}

// ─── Status (ComponentsV2) ──────────────────────────────────────────────────────

function addSection(container: ContainerBuilder, content: string): void {
    container.addTextDisplayComponents((td) => td.setContent(content));
    container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
}

function buildStatusContainer(client: BotClient): ContainerBuilder {
    const mem = process.memoryUsage();
    const pool = getPoolStats();
    const eventLoop = getEventLoopLag();
    const lastTick = getLastTickStats();

    const container = new ContainerBuilder().setAccentColor(0x5865f2);

    container.addTextDisplayComponents((td) => td.setContent("## 🤖 Bot Status"));
    container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small));

    addSection(
        container,
        [
            `**Uptime:** ${formatUptime(process.uptime())}`,
            `**Cogs:** ${client.cogs.size}`,
            `**Commands:** ${client.commands.size}`,
            `**Guilds:** ${client.guilds.cache.size}`,
        ].join("\n"),
    );

    addSection(
        container,
        [
            `**Ping:** ${client.ws.ping}ms`,
            `**Memory:** ${formatMb(mem.rss)} RSS, ${formatMb(mem.heapUsed)}/${formatMb(mem.heapTotal)} heap`,
        ].join("\n"),
    );

    container.addTextDisplayComponents((td) =>
        td.setContent(
            [
                `-# DB pool: ${pool.total} total, ${pool.idle} idle, ${pool.waiting} waiting${pool.waiting > 0 ? " ⚠️" : ""}`,
                `-# Event loop lag: ${eventLoop.meanMs}ms mean, ${eventLoop.maxMs}ms max${eventLoop.maxMs > 100 ? " ⚠️" : ""}`,
                lastTick
                    ? `-# Last activity sweep: ${lastTick.durationMs}ms for ${lastTick.userCount} user(s), <t:${Math.floor(lastTick.ranAt.getTime() / 1000)}:R>`
                    : "-# Last activity sweep: none yet",
            ].join("\n"),
        ),
    );

    return container;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function usageContainer(): ContainerBuilder {
    const container = new ContainerBuilder().setAccentColor(0x5865f2);
    container.addTextDisplayComponents((td) => td.setContent("## 🤖 Bot Administration"));
    container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small));

    addSection(container, "**Cog management**\n`!bot mod load <name>`\n`!bot mod unload <name>`\n`!bot mod reload <name>`");
    addSection(container, "**Bot**\n`!bot sync` - sync slash commands\n`!bot reload-all` - hot reload the whole bot (no restart)\n`!bot status` - bot info\n`!bot shutdown` - graceful shutdown");
    addSection(container, "**Logging**\n`!bot log set <level> [target]` - change console/file log level (runtime only)\n`!bot log show` - show current levels");
    container.addTextDisplayComponents((td) =>
        td.setContent("**Debug**\n`!bot commands` - commands per cog\n`!bot servers` - server list\n`!bot ping` - WebSocket + database\n`!bot memory` - detailed memory/CPU\n`!bot db` - connection pool\n`!bot event-loop` - lag percentiles\n`!bot uptime` - just the uptime\n`!bot invite` - invite link"),
    );

    return container;
}

function formatMb(bytes: number): string {
    return `${Math.round(bytes / 1024 / 1024)}MB`;
}

function formatUptime(seconds: number): string {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return [d && `${d}d`, h && `${h}h`, m && `${m}m`, `${s}s`].filter(Boolean).join(" ");
}
