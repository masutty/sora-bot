import {
    EmbedBuilder,
    time,
} from "discord.js";

import type { AdminCommandModule } from "../../../../types";
import * as userRepository from "@/modules/biomehunt/repository/User";
import { formatTime } from "@/utils/format";

const command: AdminCommandModule = {
    builder: sub =>
        sub
            .setDescription("View biome hunt user profile")
            .addUserOption(opt =>
                opt
                    .setName("user")
                    .setDescription("User to view")
                    .setRequired(true),
            ),

    execute: async interaction => {
        const user = interaction.options.getUser("user", true);

        const profile = await userRepository.getUserProfile(
            user.id,
            interaction.guildId!,
        );

        if (!profile) {
            await interaction.editReply({
                content: "❌ This user has no profile. They need to run `/bh setup` first.",
            });
            return;
        }

        const biomeEntries = Object.entries(profile.biomeCounts ?? {})
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([biome, count]) => `• **${biome}** → ${count}`)
            .join("\n") || "No biome data.";

        const embed = new EmbedBuilder()
            .setTitle(`👤 User Profile`)
            .setDescription(`${user.tag}`)
            .setThumbnail(user.displayAvatarURL())
            .addFields(
                {
                    name: "State",
                    value: profile.currentState.toUpperCase(),
                    inline: true,
                },
                {
                    name: "Messages",
                    value: profile.totalMessages.toLocaleString(),
                    inline: true,
                },
                {
                    name: "Active Time",
                    value: formatTime(profile.totalActiveS),
                    inline: true,
                },
                {
                    name: "Last Activity",
                    value: profile.lastActivity
                        ? time(profile.lastActivity, "R")
                        : "Never",
                    inline: true,
                },
                {
                    name: "Dedicated Channel",
                    value: `<#${profile.dedicatedChannelId}>`,
                    inline: true,
                },
                {
                    name: "Webhook",
                    value: profile.webhookId
                        ? `Configured (\`${profile.webhookId}\`)`
                        : "None",
                    inline: true,
                },
                {
                    name: "Biomes (Top 10)",
                    value: biomeEntries,
                },
                {
                    name: "Registered",
                    value: time(profile.registeredAt, "F"),
                    inline: true,
                },
                {
                    name: "Updated",
                    value: time(profile.updatedAt, "R"),
                    inline: true,
                },
            )
            .setColor(
                profile.currentState === "green"
                    ? 0x2ecc71
                    : profile.currentState === "yellow"
                        ? 0xf1c40f
                        : 0xe74c3c,
            );

        await interaction.editReply({
            embeds: [embed],
        });
    },
};

export default command;
