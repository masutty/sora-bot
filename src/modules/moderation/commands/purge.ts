import { EmbedBuilder, PermissionFlagsBits, SlashCommandBuilder, TextChannel } from "discord.js";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";

export default defineCommand({
    name: "purge",
    description: "Deletes messages from the current channel.",
    category: CommandCategory.MODERATION,

    options: new SlashCommandBuilder()
        .addNumberOption((o) =>
            o.setName("amount").setDescription("Number of messages to delete (1–100)").setRequired(true).setMinValue(1).setMaxValue(100),
        )
        .addUserOption((o) =>
            o.setName("user").setDescription("Only delete messages from this user").setRequired(false),
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

    async execute(ctx) {
        if (!ctx.guild) {
            await ctx.reply({ content: "Servers only!", ephemeral: true });
            return;
        }

        let amount = ctx.args.getNumber("amount");
        if (!amount) {
            await ctx.reply({ content: "❌ Amount required.", ephemeral: true });
            return;
        }

        const targetUser = ctx.args.getUser("user");
        const channel = ctx.channel as TextChannel;

        await ctx.deferReply({ ephemeral: false, silent: true });

        const fetched = await channel.messages.fetch({ limit: 100 });

        let toDelete = targetUser
            ? fetched.filter((m) => m.author.id === targetUser.id)
            : fetched;

        if (ctx.isPrefix()) {
            // delete the invoker's message
            toDelete.set(ctx.source.id, ctx.source as never);
            amount += 1;
        }

        toDelete = toDelete.first(amount) as never;

        const deleted = await channel.bulkDelete(toDelete, true).catch(() => null);
        const count = deleted?.size ?? 0;

        // se for slash, dá reply
        // se for prefix, usa o send (nao tem como dar reply pq o invoke foi deletado)

        const embed = new EmbedBuilder()
            .setColor(0x57f287)
            .setDescription(
                `✅ Deleted **${count}** message${count !== 1 ? "s" : ""}${targetUser ? ` from **${targetUser.username}**` : ""
                }.`,
            );

        if (ctx.isSlash()) {
            await ctx.reply({ embeds: [embed] });
            return;
        } else {
            await ctx.send({ embeds: [embed], deleteAfter: 4000 });
            return;
        }
    },
});
