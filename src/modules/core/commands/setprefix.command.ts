import { PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import { invalidatePrefixCache, updateGuildPrefix } from "../../../database/guild.repository";

export default defineCommand({
    name: "setprefix",
    description: "Defines my prefix on this server!",
    category: CommandCategory.UTILITY,
    showOnHelp: true,
    adminOnly: true,
    guildOnly: true,

    options: new SlashCommandBuilder()
        .addStringOption((opt) =>
            opt
                .setName("prefix")
                .setDescription("New prefix")
                .setRequired(true)
                .setMaxLength(5),
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async run(ctx) {
        const newPrefix = ctx.args.getString("prefix")?.trim();
        if (!newPrefix || !/^[^\s]{1,5}$/.test(newPrefix)) {
            await ctx.reply("❌ Invalid prefix (1-5 characters, no spaces).", { ephemeral: true });
            return;
        }

        await updateGuildPrefix(ctx.guild.id, newPrefix);
        invalidatePrefixCache(ctx.guild.id);
        await ctx.reply(`✅ Prefix updated to \`${newPrefix}\``);
    },
});
