import { EmbedBuilder, PermissionFlagsBits, SlashCommandBuilder, TextChannel } from "discord.js";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import { Logger } from "@/utils/logging";

const logger = new Logger("moderation.commands.purge");

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
        logger.debug(`Target user is: ${targetUser}}`);

        const channel = ctx.channel as TextChannel;

        await ctx.deferReply({ ephemeral: false, silent: true });

        // get messages from channel
        const fetched = await channel.messages.fetch({ limit: 100 });

        // filter messages by user if needed
        let toDelete = fetched.filter(m =>
            targetUser ? m.author.id === targetUser.id : true
        );

        // if prefix, force mark the invoke message into the delete list
        if (ctx.isPrefix()) {
            const selfMsg = fetched.get(ctx.source.id);
            if (selfMsg) toDelete.set(selfMsg.id, selfMsg);
        }

        // sort messages by date
        toDelete = toDelete.sort((a, b) =>
            b.createdTimestamp - a.createdTimestamp
        );

        // slice the desired amount to delete (increment by one if run as prefix to account for invoke message)
        const array = toDelete.first(amount + (ctx.isPrefix() ? 1 : 0));

        // bulk delete everything at once
        const deleted = await channel.bulkDelete(array, true).catch(() => null);
        const count = deleted?.size ?? 0;

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
            // cant reply, the invoke message was deleted, so just send a temp message instead
            await ctx.send({ embeds: [embed], deleteAfter: 4000 });
            return;
        }
    },
});
