import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import { loadCog, unloadCog, reloadCog } from "@/core/CogLoader";
import { registerSlashCommands } from "@/core/CommandHandler";
import { join } from "path";
import { Logger } from "@/utils/logging";

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
            const result = await runSubcommand(routeKey, interaction.options.getString("name"), client);
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
            const result = await runSubcommand(routeKey, args.getString("name"), client);
            await message.reply({ embeds: [successEmbed(result)] });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(err instanceof Error ? err : new Error(msg));
            await message.reply({ embeds: [errorEmbed(msg)] });
        }
    },
});

// ─── Shared logic ─────────────────────────────────────────────────────────────

async function runSubcommand(
    sub: string,
    name: string | null,
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

        case "sync": {
            const guildId = process.env.NODE_ENV === "development"
                ? process.env.DEV_GUILD_ID
                : undefined;
            await registerSlashCommands(client, guildId);
            return `Slash command tree synced (${client.commands.size} commands).`;
        }

        case "status": {
            const mem = process.memoryUsage();
            return [
                `**Uptime:** ${formatUptime(process.uptime())}`,
                `**Cogs:** ${client.cogs.size}`,
                `**Commands:** ${client.commands.size}`,
                `**Guilds:** ${client.guilds.cache.size}`,
                `**Ping:** ${client.ws.ping}ms`,
            ].join("\n");
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
        ]);
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
