import { EmbedBuilder, PermissionFlagsBits, Role, SlashCommandBuilder } from "discord.js";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";

export const rolCreateCommand = defineCommand({
    name: "rolcreate",
    description: "Creates a role.",
    category: CommandCategory.MODERATION,

    options: new SlashCommandBuilder()
        .addStringOption((o) =>
            o.setName("name").setDescription("Role name").setRequired(true),
        )
        .addStringOption((o) =>
            o.setName("color").setDescription("Hex color (e.g. #ff0000)").setRequired(false),
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

    async execute(ctx) {
        if (!ctx.guild) { await ctx.reply({ content: "Servers only!", ephemeral: true }); return; }

        const name = ctx.args.getString("name")!;
        const colorRaw = ctx.args.getString("color");
        let color: number | undefined;

        if (colorRaw) {
            const parsed = parseInt(colorRaw.replace("#", ""), 16);
            if (isNaN(parsed)) { await ctx.reply({ content: "❌ Invalid hex color.", ephemeral: true }); return; }
            color = parsed;
        }

        const role = await ctx.guild.roles.create({ name, color });

        await ctx.reply({
            embeds: [
                new EmbedBuilder()
                    .setColor(color ?? 0x5865f2)
                    .setDescription(`✅ Role **${role.name}** created.`)
                    .addFields({ name: "ID", value: role.id, inline: true }),
            ],
        });
    },
});

export const rolDeleteCommand = defineCommand({
    name: "roldelete",
    description: "Deletes a role.",
    category: CommandCategory.MODERATION,

    options: new SlashCommandBuilder()
        .addRoleOption((o) =>
            o.setName("role").setDescription("Role to delete").setRequired(true),
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

    async execute(ctx) {
        if (!ctx.guild) { await ctx.reply({ content: "Servers only!", ephemeral: true }); return; }

        const role = ctx.args.getRole("role");
        if (!role) { await ctx.reply({ content: "❌ Role not found.", ephemeral: true }); return; }

        const name = role.name;
        await role.delete();

        await ctx.reply({
            embeds: [new EmbedBuilder().setColor(0x57f287).setDescription(`✅ Role **${name}** deleted.`)],
        });
    },
});

export const rolInfoCommand = defineCommand({
    name: "rolinfo",
    description: "Shows info about a role.",
    category: CommandCategory.MODERATION,

    options: new SlashCommandBuilder()
        .addRoleOption((o) =>
            o.setName("role").setDescription("Target role").setRequired(true),
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

    async execute(ctx) {
        if (!ctx.guild) { await ctx.reply({ content: "Servers only!", ephemeral: true }); return; }

        const role = ctx.args.getRole("role") as Role;
        if (!role) { await ctx.reply({ content: "❌ Role not found.", ephemeral: true }); return; }

        const members = ctx.guild.members.cache.filter((m) => m.roles.cache.has(role.id));
        const created = `<t:${Math.floor(role.createdTimestamp / 1000)}:D>`;

        await ctx.reply({
            embeds: [
                new EmbedBuilder()
                    .setColor(role.color || 0x5865f2)
                    .setTitle(role.name)
                    .addFields(
                        { name: "ID", value: role.id, inline: true },
                        { name: "Color", value: role.hexColor, inline: true },
                        { name: "Members", value: String(members.size), inline: true },
                        { name: "Mentionable", value: role.mentionable ? "Yes" : "No", inline: true },
                        { name: "Hoisted", value: role.hoist ? "Yes" : "No", inline: true },
                        { name: "Position", value: String(role.position), inline: true },
                        { name: "Created", value: created, inline: true },
                    ),
            ],
        });
    },
});

export const rolAddUserCommand = defineCommand({
    name: "roladduser",
    description: "Adds a role to a user.",
    category: CommandCategory.MODERATION,

    options: new SlashCommandBuilder()
        .addUserOption((o) =>
            o.setName("user").setDescription("Target user").setRequired(true),
        )
        .addRoleOption((o) =>
            o.setName("role").setDescription("Role to add").setRequired(true),
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

    async execute(ctx) {
        if (!ctx.guild) { await ctx.reply({ content: "Servers only!", ephemeral: true }); return; }

        const user = ctx.args.getUser("user");
        const role = ctx.args.getRole("role");
        if (!user || !role) { await ctx.reply({ content: "❌ User and role required.", ephemeral: true }); return; }

        const member = ctx.guild.members.cache.get(user.id);
        if (!member) { await ctx.reply({ content: "❌ Member not found.", ephemeral: true }); return; }
        if (member.roles.cache.has(role.id)) { await ctx.reply({ content: `❌ <@${user.id}> already has **${role.name}**.`, ephemeral: true }); return; }

        await member.roles.add(role.id);

        await ctx.reply({
            embeds: [new EmbedBuilder().setColor(0x57f287).setDescription(`✅ Added **${role.name}** to <@${user.id}>.`)],
        });
    },
});

export const rolRemoveUserCommand = defineCommand({
    name: "rolremoveuser",
    description: "Removes a role from a user.",
    category: CommandCategory.MODERATION,

    options: new SlashCommandBuilder()
        .addUserOption((o) =>
            o.setName("user").setDescription("Target user").setRequired(true),
        )
        .addRoleOption((o) =>
            o.setName("role").setDescription("Role to remove").setRequired(true),
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

    async execute(ctx) {
        if (!ctx.guild) { await ctx.reply({ content: "Servers only!", ephemeral: true }); return; }

        const user = ctx.args.getUser("user");
        const role = ctx.args.getRole("role");
        if (!user || !role) { await ctx.reply({ content: "❌ User and role required.", ephemeral: true }); return; }

        const member = ctx.guild.members.cache.get(user.id);
        if (!member) { await ctx.reply({ content: "❌ Member not found.", ephemeral: true }); return; }
        if (!member.roles.cache.has(role.id)) { await ctx.reply({ content: `❌ <@${user.id}> doesn't have **${role.name}**.`, ephemeral: true }); return; }

        await member.roles.remove(role.id);

        await ctx.reply({
            embeds: [new EmbedBuilder().setColor(0x57f287).setDescription(`✅ Removed **${role.name}** from <@${user.id}>.`)],
        });
    },
});
