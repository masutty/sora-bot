import { EmbedBuilder, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import { addNote, deleteNote, getNotes } from "../repository";

export const noteCommand = defineCommand({
    name: "note",
    description: "Adds a note to a user.",
    category: CommandCategory.MODERATION,

    options: new SlashCommandBuilder()
        .addUserOption((o) =>
            o.setName("user").setDescription("Target user").setRequired(true),
        )
        .addStringOption((o) =>
            o.setName("note").setDescription("Note content").setRequired(true),
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

    async execute(ctx) {
        if (!ctx.guild) { await ctx.reply({ content: "Servers only!", ephemeral: true }); return; }

        const user = ctx.args.getUser("user");
        const content = ctx.args.getString("note");
        if (!user || !content) { await ctx.reply({ content: "❌ User and note content required.", ephemeral: true }); return; }

        const note = await addNote(user.id, ctx.guild.id, ctx.user.id, content);

        await ctx.reply({
            embeds: [
                new EmbedBuilder()
                    .setColor(0x5865f2)
                    .setDescription(`✅ Note **#${note.id}** added to <@${user.id}>.`)
                    .addFields({ name: "Content", value: content }),
            ],
            ephemeral: true,
        });
    },
});

export const noteDelCommand = defineCommand({
    name: "notedel",
    description: "Removes a note.",
    category: CommandCategory.MODERATION,

    options: new SlashCommandBuilder()
        .addIntegerOption((o) =>
            o.setName("id").setDescription("Note ID").setRequired(true).setMinValue(1),
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

    async execute(ctx) {
        if (!ctx.guild) { await ctx.reply({ content: "Servers only!", ephemeral: true }); return; }

        const id = ctx.args.getNumber("id");
        if (!id) { await ctx.reply({ content: "❌ Note ID required.", ephemeral: true }); return; }

        const deleted = await deleteNote(id, ctx.guild.id);

        await ctx.reply({
            embeds: [
                new EmbedBuilder()
                    .setColor(deleted ? 0x57f287 : 0xff0000)
                    .setDescription(deleted ? `✅ Note **#${id}** deleted.` : `❌ Note **#${id}** not found.`),
            ],
            ephemeral: true,
        });
    },
});

export const notesCommand = defineCommand({
    name: "notes",
    description: "Lists all notes for a user.",
    category: CommandCategory.MODERATION,

    options: new SlashCommandBuilder()
        .addUserOption((o) =>
            o.setName("user").setDescription("Target user").setRequired(true),
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

    async execute(ctx) {
        if (!ctx.guild) { await ctx.reply({ content: "Servers only!", ephemeral: true }); return; }

        const user = ctx.args.getUser("user");
        if (!user) { await ctx.reply({ content: "❌ User required.", ephemeral: true }); return; }

        const notes = await getNotes(user.id, ctx.guild.id);

        if (!notes.length) {
            await ctx.reply({
                embeds: [new EmbedBuilder().setColor(0x5865f2).setDescription(`No notes found for <@${user.id}>.`)],
                ephemeral: true,
            });
            return;
        }

        await ctx.reply({
            embeds: [
                new EmbedBuilder()
                    .setColor(0x5865f2)
                    .setTitle(`Notes for ${user.username}`)
                    .setDescription(
                        notes.map((n) => {
                            const date = `<t:${Math.floor(new Date(n.created_at).getTime() / 1000)}:D>`;
                            return `**#${n.id}** · <@${n.moderator_id}> · ${date}\n${n.content}`;
                        }).join("\n\n"),
                    ),
            ],
            ephemeral: true,
        });
    },
});
