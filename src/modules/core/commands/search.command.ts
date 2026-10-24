import type { GuildMember, User } from "discord.js";
import { ContainerBuilder, MessageFlags, SeparatorSpacingSize, SlashCommandBuilder } from "discord.js";
import type { CommandMode } from "@/core/command/command-context";
import { isAllowed, type RawOption, SUB_COMMAND, SUB_COMMAND_GROUP, subcommandKey } from "@/core/command/command-dispatch";
import { checkGuards } from "@/core/guards";
import { defineCommand, UserFacingError } from "@/define";
import { CommandCategory, type CommandDefinition } from "@/types";
import { config } from "../../../config";

const ACCENT = 0x5865f2;
const MAX_RESULTS = 10;

/** Who is searching - results only list what this user could actually run, where they are. */
export interface SearchViewer {
    user: User;
    member: GuildMember | null;
    inGuild: boolean;
    mode: CommandMode;
    /** The prefix the viewer typed (or the server's), for prefix-style usage. */
    prefix: string;
}

export interface SearchHit {
    usage: string;
    /** The command words (`bh shop`) - ties sort by these, whatever the prefix. */
    path: string;
    description: string;
    score: number;
}

/** A runnable entry of a command: the command itself, or each of its subcommands. */
interface Leaf {
    path: string[];
    key: string | null;
    description: string;
}

function leaves(cmd: CommandDefinition): Leaf[] {
    const top = (cmd.options?.toJSON().options ?? []) as RawOption[];
    const out: Leaf[] = [];
    for (const opt of top) {
        if (opt.type === SUB_COMMAND) out.push({ path: [opt.name], key: subcommandKey(null, opt.name), description: opt.description });
        if (opt.type === SUB_COMMAND_GROUP) {
            for (const sub of opt.options ?? [])
                out.push({ path: [opt.name, sub.name], key: subcommandKey(opt.name, sub.name), description: sub.description });
        }
    }
    return out.length ? out : [{ path: [], key: null, description: cmd.description }];
}

/** How to invoke a leaf: in the viewer's own mode when it exists there, else in the other one. `null` = nowhere. */
function usageFor(cmd: CommandDefinition, leaf: Leaf, viewer: SearchViewer): string | null {
    if (cmd.contextMenu) return `Apps → ${cmd.name}`;
    const other: CommandMode = viewer.mode === "slash" ? "prefix" : "slash";
    const mode = isAllowed(cmd, viewer.mode, leaf.key) ? viewer.mode : isAllowed(cmd, other, leaf.key) ? other : null;
    if (!mode) return null;
    return `${mode === "slash" ? "/" : viewer.prefix}${[cmd.name, ...leaf.path].join(" ")}`;
}

/** Hidden, guild-only in a DM, or refused by the guards (owner only, admin only, allowed users, permissions) - not listed. */
async function canSee(cmd: CommandDefinition, viewer: SearchViewer): Promise<boolean> {
    if (cmd.showOnHelp === false) return false;
    if (cmd.guildOnly && !viewer.inGuild) return false;
    return (await checkGuards({ user: viewer.user, member: viewer.member }, cmd)) === null;
}

/** Every query word must appear in the name or the description; name hits weigh more. */
function score(name: string, description: string, words: string[]): number {
    const nameWords = name.split(" ");
    let total = 0;
    for (const word of words) {
        if (nameWords.includes(word)) total += 3;
        else if (name.includes(word)) total += 2;
        else if (description.includes(word)) total += 1;
        else return 0;
    }
    return total;
}

/** The commands and subcommands matching `query` that the viewer can run, best match first. */
export async function searchCommands(commands: CommandDefinition[], query: string, viewer: SearchViewer): Promise<SearchHit[]> {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];
    const hits: SearchHit[] = [];
    for (const cmd of commands) {
        if (!(await canSee(cmd, viewer))) continue;
        for (const leaf of leaves(cmd)) {
            const usage = usageFor(cmd, leaf, viewer);
            if (!usage) continue;
            const path = [cmd.name, ...leaf.path].join(" ");
            const points = score(path.toLowerCase(), leaf.description.toLowerCase(), words);
            if (points > 0) hits.push({ usage, path, description: leaf.description, score: points });
        }
    }
    return hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

function buildResults(query: string, hits: SearchHit[]): ContainerBuilder {
    const container = new ContainerBuilder().setAccentColor(ACCENT);
    container.addTextDisplayComponents((td) => td.setContent(`**Commands matching \`${query}\`**`));
    container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    const shown = hits.slice(0, MAX_RESULTS);
    const more = hits.length - shown.length;
    const lines = shown.map((h) => `\`${h.usage}\` - ${h.description}`);
    if (more > 0) lines.push(`-# +${more} more`);
    container.addTextDisplayComponents((td) => td.setContent(lines.join("\n")));
    return container;
}

export default defineCommand({
    name: "search",
    description: "Finds commands by name or description.",
    category: CommandCategory.UTILITY,
    showOnHelp: true,

    options: new SlashCommandBuilder().addStringOption((opt) =>
        opt.setName("query").setDescription("What to look for, e.g. shop").setRequired(true).setMaxLength(100),
    ),

    async run(ctx) {
        const query = (ctx.args.getString("query") ?? "").replace(/`/g, "").trim();
        if (!query) throw new UserFacingError("Tell me what to look for, e.g. `shop`.");
        // A slash call still lists prefix-only commands - with the server's prefix, not "/".
        const prefix =
            ctx.mode === "prefix"
                ? ctx.invokePrefix
                : ctx.guild
                  ? await (await import("../../../database/guild.repository")).getGuildPrefix(ctx.guild.id)
                  : config.bot.defaultPrefix;
        const hits = await searchCommands(ctx.client.commands.getAll(), query, {
            user: ctx.user,
            member: ctx.member,
            inGuild: ctx.guild !== null,
            mode: ctx.mode,
            prefix,
        });
        if (hits.length === 0) throw new UserFacingError(`No commands match \`${query}\`.`);
        await ctx.reply({ flags: MessageFlags.IsComponentsV2, components: [buildResults(query, hits)] });
    },
});
