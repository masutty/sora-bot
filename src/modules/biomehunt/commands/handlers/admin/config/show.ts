import { getGuildConfig } from "@/modules/biomehunt/services/GuildConfigCache";
import type { AdminCommandModule } from "../../../../types";
import { channelMention, EmbedFormatter, roleMention } from "@/utils/format";

const command: AdminCommandModule = {
    builder: sub => sub
        .setDescription("Shows all current config values."),

    execute: async interaction => {
        const config = await getGuildConfig(interaction.guildId!);

        if (!config) {
            await interaction.editReply({ embeds: [EmbedFormatter.warn("No configuration found. Run the `/bh-admin config [setting]` commands to get started.")] });
            return;
        }

        const roleDisplay = (id: string | null) => id ? roleMention(id) : "*not set*";
        const chanDisplay = (id: string | null) => id ? channelMention(id) : "*not set*";
        const cats = config.macroCategoryIds.length > 0
            ? config.macroCategoryIds.map(id => `\`${id}\``).join(", ")
            : "*none*";

        await interaction.editReply([
            "## BiomeHunter Configuration",
            `🟢 Green role:  ${roleDisplay(config.greenRoleId)}`,
            `🟡 Yellow role: ${roleDisplay(config.yellowRoleId)}  ·  threshold **${config.yellowThresholdS}s**`,
            `🔴 Red role:    ${roleDisplay(config.redRoleId)}  ·  threshold **${config.redThresholdS}s**`,
            `📊 Counter channel: ${chanDisplay(config.counterChannelId)}`,
            `📁 Macro categories: ${cats}`,
        ].join("\n"));
    }
};

export default command;
