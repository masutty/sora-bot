import { setGuildConfig } from "@/modules/biomehunt/services/GuildConfigCache";
import { roleMention } from "@/utils/format";
import type { AdminCommandModule } from "../../../../types";

const command: AdminCommandModule = {
    builder: sub => sub
        .setDescription("Set yellow role")
        .addRoleOption(opt => opt
            .setName("role")
            .setDescription("Role to set as yellow")
            .setRequired(true)
        ),

    execute: async interaction => {
        const role = interaction.options.getRole("role", true);
        await setGuildConfig(interaction.guildId!, { yellowRoleId: role.id });
        await interaction.editReply(`✅ Yellow role set to ${roleMention(role.id)}.`);
    }
};

export default command;
