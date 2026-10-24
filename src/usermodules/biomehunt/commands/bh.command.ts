import type { Guild, GuildMember } from "discord.js";
import { SlashCommandBuilder } from "discord.js";
import { defineCommand, type GuildCommandContext } from "@/define";
import { CommandCategory } from "@/types";
import { EmbedFormatter, type FormattedReply, NO_PINGS } from "@/utils/format";
import { getBalance } from "../services/economy.service";
import { provisionMacroChannel } from "../services/macro-channel.service";
import { BiomeHuntError } from "../types";
import { buildBalanceReply } from "../views/balance.view";
import { openProfileView } from "../views/profile.view";
import { openRareFindsView } from "../views/rare-finds.view";
import { openRerollView } from "../views/reroll.view";
import { openSessionView } from "../views/session.view";
import { memberShopView } from "../views/shop.view";

export const PROFILE_DESCRIPTION = "View your hunt profile, or someone else's.";
export const PROFILE_USER_DESCRIPTION = "Whose profile to view (defaults to yourself)";
export const REROLL_DESCRIPTION = "Reroll your Flower for 50 Seeds.";
export const SHOP_DESCRIPTION = "Spend your Seeds in this server's shop.";

/** `/bh profile` and its `/profile` alias. */
export async function runProfile(ctx: GuildCommandContext): Promise<void> {
    // Supplied-but-unresolvable user -> framework error; omitted -> your own profile.
    const target = (await ctx.args.getMember("user")) ?? ctx.member;
    await ctx.defer();
    await openProfileView(ctx, ctx.guild.id, target);
}

/** `/bh reroll` and its `/reroll` alias. */
export async function runReroll(ctx: GuildCommandContext): Promise<void> {
    await ctx.defer();
    await openRerollView(ctx, ctx.client, ctx.guild.id, ctx.user.id);
}

export default defineCommand({
    name: "bh",
    description: "Biome hunting commands.",
    category: CommandCategory.UTILITY,
    showOnHelp: true,
    guildOnly: true,

    options: new SlashCommandBuilder()
        .addSubcommand((sub) => sub.setName("setup").setDescription("Set up your hunt macro channel."))
        .addSubcommand((sub) =>
            sub
                .setName("profile")
                .setDescription(PROFILE_DESCRIPTION)
                .addUserOption((o) => o.setName("user").setDescription(PROFILE_USER_DESCRIPTION)),
        )
        .addSubcommand((sub) => sub.setName("reroll").setDescription(REROLL_DESCRIPTION))
        .addSubcommand((sub) => sub.setName("shop").setDescription(SHOP_DESCRIPTION))
        .addSubcommand((sub) =>
            sub
                .setName("session")
                .setDescription("Inspect one macro session.")
                .addIntegerOption((o) => o.setName("id").setDescription("Session id").setRequired(true).setMinValue(1)),
        )
        .addSubcommand((sub) =>
            sub
                .setName("rare-finds")
                .setDescription("View a member's rare biome finds.")
                .addUserOption((o) => o.setName("user").setDescription("Whose rare finds to view (defaults to yourself)")),
        )
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
            await runProfile(ctx);
            return;
        }

        if (sub === "balance") {
            // Same target rule as profile: omitted -> yourself; supplied-but-not-a-member -> framework error.
            const target = (await ctx.args.getMember("user")) ?? ctx.member;
            const balance = await getBalance(ctx.guild.id, target.id);
            await ctx.reply(buildBalanceReply(target.id, target.id === ctx.user.id, balance));
            return;
        }

        if (sub === "session") {
            await ctx.defer();
            await openSessionView(ctx, ctx.guild.id, ctx.args.getInteger("id", true));
            return;
        }

        if (sub === "rare-finds") {
            // Same target rule as profile: omitted -> yourself; supplied-but-not-a-member -> framework error.
            const target = (await ctx.args.getMember("user")) ?? ctx.member;
            await ctx.defer();
            await openRareFindsView(ctx, ctx.guild.id, target);
            return;
        }

        if (sub === "reroll") {
            await runReroll(ctx);
            return;
        }

        if (sub === "shop") {
            await ctx.defer();
            // Lazy: the real repositories load only when the shop opens.
            const { getUserByDiscordId } = await import("../repository/users.repository");
            const user = await getUserByDiscordId(ctx.guild.id, ctx.user.id);
            if (!user) {
                await ctx.reply({
                    ...EmbedFormatter.info("You don't have a profile yet!\n\nRun `/bh setup` to get started."),
                    allowedMentions: NO_PINGS,
                });
                return;
            }
            const { defaultMemberShopDeps } = await import("../services/member-shop-deps.service");
            await ctx.open(memberShopView(defaultMemberShopDeps(ctx.client, ctx.guild, ctx.member)), { guildId: ctx.guild.id, user });
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
