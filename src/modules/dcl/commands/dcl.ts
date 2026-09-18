import type { Message } from "discord.js";
import { SlashCommandBuilder } from "discord.js";
import { join } from "path";
import { config } from "@/config";
import type { BotClient } from "@/core/BotClient";
import {
    getCogOrigin,
    getDclRuntimeDir,
    installCogFromSource,
    loadCog,
    reloadCog,
    unloadCog,
} from "@/core/CogLoader";
import { getGuildPrefix } from "@/database/guildRepository";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import { EmbedFormatter, extractCodeBlock } from "@/utils/format";
import { resolveMessageSource } from "@/utils/messageSource";

const COGS_PATH = join(__dirname, "../../");

/** `load`/`reload` of a name already loaded this session via `!dcl run` need to find that version
 * in the DCL sandbox again, not in `COGS_PATH` (where there might not even be a matching folder) -
 * `getCogOrigin` remembers where each cog actually came from. */
function resolveBasePath(name: string): string {
    return getCogOrigin(name) ?? COGS_PATH;
}

const USAGE =
    "`!dcl status <name>`\n`!dcl load <name>`\n`!dcl unload <name>`\n`!dcl reload <name>` - turns it on if it was off, restarts it if it was on\n`!dcl list` - lists active/disabled cogs\n`!dcl run` - installs/updates a cog from an attached or pasted .ts file (prefix only)";

export default defineCommand({
    name: "dcl",
    description: "Dynamic Cog Loader - runtime cog management.",
    category: CommandCategory.ADMIN,
    botOwnerOnly: true,
    showOnHelp: false,

    options: new SlashCommandBuilder()
        .addSubcommand((s) =>
            s
                .setName("status")
                .setDescription("Shows whether a cog is loaded.")
                .addStringOption((o) => o.setName("name").setDescription("Cog name").setRequired(true)),
        )
        .addSubcommand((s) =>
            s
                .setName("load")
                .setDescription("Loads a cog that already exists on disk.")
                .addStringOption((o) => o.setName("name").setDescription("Cog name").setRequired(true)),
        )
        .addSubcommand((s) =>
            s
                .setName("unload")
                .setDescription("Unloads a cog.")
                .addStringOption((o) => o.setName("name").setDescription("Cog name").setRequired(true)),
        )
        .addSubcommand((s) =>
            s
                .setName("reload")
                .setDescription("Turns a cog on/off (loads it if off; unloads and reloads it if on).")
                .addStringOption((o) => o.setName("name").setDescription("Cog name").setRequired(true)),
        )
        .addSubcommand((s) => s.setName("list").setDescription("Lists active and disabled cogs."))
        .addSubcommand((s) =>
            s.setName("run").setDescription("Installs/updates a cog from code sent on the spot (prefix only)."),
        ),

    // ── Slash ─────────────────────────────────────────────────────────────────
    async executeAsSlash(interaction, client) {
        const sub = interaction.options.getSubcommand(true);

        if (sub === "run") {
            await interaction.reply({
                ...EmbedFormatter.info("This subcommand only works via prefix (`!dcl run <code>`)"),
                ephemeral: true,
            });
            return;
        }

        await interaction.deferReply({ ephemeral: true });
        try {
            const result = await runSubcommand(sub, interaction.options.getString("name"), client);
            await interaction.editReply(EmbedFormatter.success(result));
        } catch (err) {
            await interaction.editReply(EmbedFormatter.error(err instanceof Error ? err.message : String(err)));
        }
    },

    // ── Prefix ────────────────────────────────────────────────────────────────
    async executeAsPrefix(message, args, client) {
        const sub = args.getSubcommand();
        if (!sub) {
            await message.reply(EmbedFormatter.warn(USAGE));
            return;
        }

        if (sub === "run") {
            await handleRun(message, client);
            return;
        }

        try {
            const result = await runSubcommand(sub, args.getString("name"), client);
            await message.reply(EmbedFormatter.success(result));
        } catch (err) {
            await message.reply(EmbedFormatter.error(err instanceof Error ? err.message : String(err)));
        }
    },
});

// ─── status/load/unload/reload/list ─────────────────────────────────────────────

async function runSubcommand(sub: string, name: string | null, client: BotClient): Promise<string> {
    switch (sub) {
        case "status": {
            if (!name) throw new Error("Cog name is required.");
            const cog = client.cogs.get(name);
            if (!cog) {
                const disabled = config.bot.disabledCogs.includes(name);
                return `Cog \`${name}\` is not loaded${disabled ? " (:warning: `DISABLED_COGS`)" : ""}.`;
            }
            const isRuntime = getCogOrigin(name) === getDclRuntimeDir(COGS_PATH);
            const runtimeNote = isRuntime
                ? "\n-# Installed via `!dcl run` - only runs for this session, forgotten on a process restart."
                : "";
            return `Cog \`${cog.name}\` active - ${cog.commands?.length ?? 0} command(s), ${Object.keys(cog.events ?? {}).length} event(s).${runtimeNote}`;
        }

        case "load":
            if (!name) throw new Error("Cog name is required.");
            await loadCog(client, resolveBasePath(name), name);
            return `Cog \`${name}\` loaded.`;

        case "unload":
            if (!name) throw new Error("Cog name is required.");
            await unloadCog(client, name);
            return `Cog \`${name}\` unloaded.`;

        case "reload": {
            if (!name) throw new Error("Cog name is required.");
            const wasLoaded = client.cogs.has(name);
            if (wasLoaded) await reloadCog(client, COGS_PATH, name);
            else await loadCog(client, resolveBasePath(name), name);
            return `Cog \`${name}\` ${wasLoaded ? "reloaded (was active)" : "loaded (was inactive)"}.`;
        }

        case "list": {
            const active = [...client.cogs.values()].map(
                (c) => `- \`${c.name}\` - ${c.commands?.length ?? 0} command(s), ${Object.keys(c.events ?? {}).length} event(s)`,
            );
            const disabled = config.bot.disabledCogs.filter((n) => !client.cogs.has(n));
            const lines = [`**Active (${client.cogs.size}):**`, ...active];
            if (disabled.length) {
                lines.push("", `**Disabled (\`DISABLED_COGS\`):** ${disabled.map((n) => `\`${n}\``).join(", ")}`);
            }
            return lines.join("\n");
        }

        default:
            throw new Error(`Unknown subcommand: ${sub}`);
    }
}

// ─── run (installs from sent code) ──────────────────────────────────────────────

async function handleRun(message: Message, client: BotClient): Promise<void> {
    const prefix = message.guild
        ? await getGuildPrefix(message.guild.id)
        : config.bot.defaultPrefix;
    const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const runPrefixPattern = new RegExp(`^${escapedPrefix}dcl\\s+run\\s*`, "i");

    let source: string;
    try {
        source = await resolveMessageSource(message, runPrefixPattern);
    } catch (err) {
        await message.reply(EmbedFormatter.error(err instanceof Error ? err.message : String(err)));
        return;
    }

    if (!source) {
        await message.reply(
            EmbedFormatter.warn(
                "Attach a .ts/.js file with `export default defineCog({...})`, paste the code (as a code block or raw), or reply to a message with either.",
            ),
        );
        return;
    }

    try {
        const result = await installCogFromSource(client, COGS_PATH, extractCodeBlock(source));
        const overwriteNote = result.overwritten
            ? " - replaced the version that was loaded in memory, but the real `index.ts` in `src/modules` (if one exists with that name) was not touched."
            : "";
        await message.reply(
            EmbedFormatter.success(
                `Cog \`${result.name}\` ${result.overwritten ? "updated" : "installed"} - ${result.commands} command(s).${overwriteNote}\n-# Only runs for this bot session - restarting the process forgets this and goes back to normal.`,
            ),
        );
    } catch (err) {
        await message.reply(EmbedFormatter.error(err instanceof Error ? err.message : String(err)));
    }
}
