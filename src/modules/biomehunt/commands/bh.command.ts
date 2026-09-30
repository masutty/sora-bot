import type { Guild, GuildMember } from "discord.js";
import { SlashCommandBuilder } from "discord.js";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import { EmbedFormatter, type FormattedReply } from "@/utils/format";
import { getBalance } from "../services/economy.service";
import { provisionMacroChannel } from "../services/macro-channel.service";
import { BiomeHuntError } from "../types";
import { buildBalanceReply } from "../views/balance.view";
import { openProfileView } from "../views/profile.view";
import { openRerollView } from "../views/reroll.view";

export default defineCommand({
    name: "bh",
    description: "User commands for biome hunt module",
    category: CommandCategory.UTILITY,
    showOnHelp: true,
    guildOnly: true,

    options: new SlashCommandBuilder()
        .addSubcommand((sub) => sub.setName("setup").setDescription("Set up your hunt macro channel."))
        .addSubcommand((sub) =>
            sub
                .setName("profile")
                .setDescription("View your hunt profile, or someone else's.")
                .addUserOption((o) => o.setName("user").setDescription("Whose profile to view (defaults to yourself)")),
        )
        .addSubcommand((sub) => sub.setName("reroll").setDescription("Reroll your Flower for 50 Seeds."))
        .addSubcommand((sub) =>
            sub
                .setName("balance")
                .setDescription("View your Seeds and level, or someone else's.")
                .addUserOption((o) => o.setName("user").setDescription("Whose balance to view (defaults to yourself)")),
        ),
    // .addSubcommand((sub) => sub.setName("history").setDescription("View your recent activity sessions."))
    // .addSubcommand((sub) => sub.setName("leaderboard").setDescription("View the server's activity leaderboard.")),

    async run(ctx) {
        const sub = ctx.args.getSubcommand();

        if (sub === "profile") {
            // Supplied-but-unresolvable user -> framework error; omitted -> your own profile.
            const target = (await ctx.args.getMember("user")) ?? ctx.member;
            await ctx.defer();
            await openProfileView(ctx, ctx.guild.id, target);
            return;
        }

        if (sub === "balance") {
            // Same target rule as profile: omitted -> yourself; supplied-but-not-a-member -> framework error.
            const target = (await ctx.args.getMember("user")) ?? ctx.member;
            const balance = await getBalance(ctx.guild.id, target.id);
            await ctx.reply(buildBalanceReply(target.id, target.id === ctx.user.id, balance));
            return;
        }

        if (sub === "reroll") {
            await ctx.defer();
            await openRerollView(ctx, ctx.client, ctx.guild.id, ctx.user.id);
            return;
        }

        await ctx.defer({ ephemeral: sub === "setup" });
        await ctx.reply(await runSubcommand(`${sub}`, ctx.guild, ctx.member));
    },
});

async function runSubcommand(sub: string, guild: Guild, member: GuildMember): Promise<FormattedReply> {
    switch (sub) {
        case "setup": {
            const result = await provisionMacroChannel(guild, member);
            return EmbedFormatter.success(`Created: <#${result.channelId}>`);
        }
        default:
            throw new BiomeHuntError(`Unknown subcommand: ${sub}`);
    }
}
