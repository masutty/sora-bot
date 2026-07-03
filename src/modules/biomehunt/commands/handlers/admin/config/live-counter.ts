import { setGuildConfig } from "@/modules/biomehunt/services/GuildConfigCache";
import type { AdminCommandModule } from "../../../../types";
import { channelMention } from "@/utils/format";

const command: AdminCommandModule = {
    builder: sub => sub
        .setDescription("Set the channel where the live activity counter message is posted.")
        .addChannelOption(opt => opt
            .setName("channel")
            .setDescription("Channel to send and maintain counter message in.")
            .setRequired(true)
        ),

    execute: async interaction => {
        const channel = interaction.options.getChannel("channel", true);

        await setGuildConfig(interaction.guildId!, {
            counterChannelId: channel.id,
            counterMessageId: null,
        })

        await interaction.editReply(`✅ Counter channel set to ${channelMention(channel.id)}. The live message will appear there within 5 minutes.`);
    }
};

export default command;
