import type { AdminCommandModule } from "../../../../types";

const command: AdminCommandModule = {
    builder: sub => sub
        .setDescription("Not yet implemented"),

    execute: async interaction => {
        await interaction.editReply(`Not yet implemented!`);
    }
};

export default command;
