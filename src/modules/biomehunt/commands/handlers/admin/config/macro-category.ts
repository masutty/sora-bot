import { setGuildConfig } from "@/modules/biomehunt/services/GuildConfigCache";
import { roleMention } from "@/utils/format";
import type { AdminCommandModule } from "../../../../types";
import { getGuildConfig } from "@/modules/biomehunt/repository/GuildConfig";

const command: AdminCommandModule = {
    builder: sub => sub
        .setDescription("Adds a macro category to be used by the macro setup commands.")
        .addChannelOption(opt => opt
            .setName("category")
            .setDescription("A category channel to use as a macro category.")
            .setRequired(true)
        ),

    execute: async interaction => {
        const category = interaction.options.getChannel("category", true);

        const channel = await interaction.guild?.channels.fetch(category.id);
        if (!channel || channel.type !== 4 /* ChannelType.GuildCategory */) {
            await interaction.editReply("❌ That ID does not correspond to a category in this server.");
            return;
        }

        const config = await getGuildConfig(interaction.guildId!);

        await interaction.editReply(`Guild config: \n${JSON.stringify(config, null, 2)}\n\n Category you sent: \n${JSON.stringify(category, null, 2)}`);
        // await setGuildConfig(interaction.guildId!, { greenRoleId: role.id });
        // await interaction.editReply(`✅ Green role set to ${roleMention(role.id)}.`);
    }
};

export default command;
