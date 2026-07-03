import { SlashCommandBuilder } from "discord.js";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import { adminRegistry } from "./handlers/admin";

function buildAdminCommand() {
    const builder = new SlashCommandBuilder();

    for (const [groupName, group] of Object.entries(adminRegistry)) {
        builder.addSubcommandGroup(subGroup => {
            subGroup
                .setName(groupName)
                .setDescription(`${groupName} commands`);

            for (const [commandName, command] of Object.entries(group)) {
                subGroup.addSubcommand(sub =>
                    command.builder(
                        sub.setName(commandName)
                    )
                );
            }

            return subGroup;
        });
    }

    return builder;
}

export default defineCommand({
    name: "bh-admin",
    description: "BiomeHunt administration.",
    category: CommandCategory.ADMIN,
    adminOnly: true,
    showOnHelp: false,

    options: buildAdminCommand(),

    async executeAsSlash(interaction) {
        if (!interaction.guildId) {
            await interaction.reply({
                content: "This command can only be used in a server.",
                ephemeral: true,
            });
            return;
        }

        await interaction.deferReply({ ephemeral: true });

        try {
            const group = interaction.options.getSubcommandGroup(true);
            const sub = interaction.options.getSubcommand(true);

            const command = adminRegistry[group]?.[sub];

            if (!command) {
                throw new Error(`Unknown command: ${group}.${sub}`);
            }

            await command.execute(interaction);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await interaction.editReply(`❌ ${msg}`);
        }
    },
});
