import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import {
    loadModule,
    unloadModule,
    reloadModule,
} from "@/core/CogLoader";
import { registerSlashCommands } from "@/core/CommandHandler";
import { join } from "path";

const MODULES_PATH = join(__dirname, "../../../modules");

type AdminAction = "load" | "unload" | "reload";

export default defineCommand({
    name: "admin",
    description: "Bot administration.",
    category: CommandCategory.ADMIN,
    ownerOnly: true,
    prefixEnabled: true,
    hidden: true,

    options: new SlashCommandBuilder()
        .addSubcommandGroup((group) =>
            group
                .setName("module")
                .setDescription("Manage modules.")
                .addSubcommand((sub) =>
                    sub
                        .setName("load")
                        .setDescription("Load a module.")
                        .addStringOption((o) =>
                            o.setName("name").setDescription("Module name").setRequired(true),
                        ),
                )
                .addSubcommand((sub) =>
                    sub
                        .setName("unload")
                        .setDescription("Unload a module.")
                        .addStringOption((o) =>
                            o.setName("name").setDescription("Module name").setRequired(true),
                        ),
                )
                .addSubcommand((sub) =>
                    sub
                        .setName("reload")
                        .setDescription("Reload a module.")
                        .addStringOption((o) =>
                            o.setName("name").setDescription("Module name").setRequired(true),
                        ),
                ),
        )
        .addSubcommandGroup((group) =>
            group
                .setName("command")
                .setDescription("Manage commands.")
                .addSubcommand((sub) =>
                    sub
                        .setName("reload")
                        .setDescription("Reload a command's module.")
                        .addStringOption((o) =>
                            o.setName("name").setDescription("Command name").setRequired(true),
                        ),
                )
                .addSubcommand((sub) =>
                    sub
                        .setName("unload")
                        .setDescription("Unload a command.")
                        .addStringOption((o) =>
                            o.setName("name").setDescription("Command name").setRequired(true),
                        ),
                ),
        )
        .addSubcommandGroup((group) =>
            group
                .setName("commandtree")
                .setDescription("Manage slash command tree.")
                .addSubcommand((sub) =>
                    sub.setName("reload").setDescription("Sync slash commands with Discord."),
                ),
        ),

    async execute(ctx) {
        // Parse both slash and prefix
        let group: string;
        let subcommand: string;
        let target: string | null = null;

        if (ctx.isSlash()) {
            const src = ctx.source as import("discord.js").ChatInputCommandInteraction;
            group = src.options.getSubcommandGroup(true);
            subcommand = src.options.getSubcommand(true);
            target = src.options.getString("name");
        } else {
            // !admin <group> <subcommand> [target]
            const src = ctx.source as import("discord.js").Message;
            const parts = src.content.trim().split(/\s+/);
            // parts: ["!admin", "module", "reload", "tempvc"]
            group = parts[1]?.toLowerCase() ?? "";
            subcommand = parts[2]?.toLowerCase() ?? "";
            target = parts[3] ?? null;
        }

        await ctx.deferReply({ ephemeral: true });

        try {
            if (group === "commandtree" && subcommand === "reload") {
                const guildId = process.env.NODE_ENV === "development"
                    ? process.env.DEV_GUILD_ID
                    : undefined;
                await registerSlashCommands(ctx.client, guildId);
                await ctx.reply({ embeds: [successEmbed("Slash command tree synced.")] });
                return;
            }

            if (group === "module") {
                if (!target) {
                    await ctx.reply({ embeds: [errorEmbed("Module name required.")] });
                    return;
                }
                await runModuleAction(ctx.client, subcommand as AdminAction, target);
                await ctx.reply({
                    embeds: [successEmbed(`Module \`${target}\` ${subcommand}ed successfully.`)],
                });
                return;
            }

            if (group === "command") {
                if (!target) {
                    await ctx.reply({ embeds: [errorEmbed("Command name required.")] });
                    return;
                }

                if (subcommand === "unload") {
                    const exists = ctx.client.commands.get(target);
                    if (!exists) {
                        await ctx.reply({ embeds: [errorEmbed(`Command \`${target}\` not found.`)] });
                        return;
                    }
                    ctx.client.commands.delete(target);
                    await ctx.reply({
                        embeds: [successEmbed(`Command \`${target}\` unloaded.`)],
                    });
                    return;
                }

                if (subcommand === "reload") {
                    // Encontra qual módulo possui o comando e recarrega o módulo inteiro
                    const moduleName = findModuleForCommand(ctx.client, target);
                    if (!moduleName) {
                        await ctx.reply({ embeds: [errorEmbed(`No module found owning command \`${target}\`.`)] });
                        return;
                    }
                    await reloadModule(ctx.client, MODULES_PATH, moduleName);
                    await ctx.reply({
                        embeds: [successEmbed(`Module \`${moduleName}\` reloaded (owns \`${target}\`).`)],
                    });
                    return;
                }
            }

            await ctx.reply({ embeds: [errorEmbed("Unknown action.")] });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await ctx.reply({ embeds: [errorEmbed(msg)] });
        }
    },
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function runModuleAction(
    client: import("@/core/BotClient").BotClient,
    action: AdminAction,
    moduleName: string,
): Promise<void> {
    switch (action) {
        case "load":
            await loadModule(client, MODULES_PATH, moduleName);
            break;
        case "unload":
            await unloadModule(client, moduleName);
            break;
        case "reload":
            await reloadModule(client, MODULES_PATH, moduleName);
            break;
        default:
            throw new Error(`Unknown action: ${action}`);
    }
}

function findModuleForCommand(
    client: import("@/core/BotClient").BotClient,
    commandName: string,
): string | null {
    for (const [modName, mod] of client.modules) {
        if (mod.commands?.some((c) => c.name === commandName)) {
            return modName;
        }
    }
    return null;
}

function successEmbed(msg: string): EmbedBuilder {
    return new EmbedBuilder().setColor(0x57f287).setDescription(`✅ ${msg}`);
}

function errorEmbed(msg: string): EmbedBuilder {
    return new EmbedBuilder().setColor(0xff0000).setDescription(`❌ ${msg}`);
}
