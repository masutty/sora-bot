import { setGuildConfig } from "@/modules/biomehunt/services/GuildConfigCache";
import { roleMention } from "@/utils/format";
import type { AdminCommandModule } from "../../../../types";

const command: AdminCommandModule = {
    builder: sub => sub
        .setDescription("Set red role")
        .addRoleOption(opt => opt
            .setName("role")
            .setDescription("Role to set as red")
            .setRequired(true)
        ),

    execute: async interaction => {
        const role = interaction.options.getRole("role", true);
        await setGuildConfig(interaction.guildId!, { redRoleId: role.id });
        await interaction.editReply(`✅ Red role set to ${roleMention(role.id)}.`);
    }
};

export default command;
