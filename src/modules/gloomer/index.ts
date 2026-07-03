import { defineModule, defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import { Logger } from "@/utils/logging";

const logger = new Logger("gloomer.index");

const giveAuraCommand = defineCommand({
    name: "give-aura",
    description: "Check one specific aura",
    category: CommandCategory.UTILITY,
    args: [
        {
            name: "aura",
            type: "string",
            required: true,
            description: "Aura to check",
        }
    ],
    async execute(ctx) {
        logger.debug(`Execution context: ${Logger.stringify(ctx)}`);

        // here we would get the arguments, check if they are valid, and shit
    }
})

export default defineModule({
    name: "gloomy-auras",
    description: "Aura Rolling module",
    authors: [{ name: "masutty", id: 188851299255713792n }],
    migrations: [], // here we would put all the database tables we need for this "aura" module
    // we could have one table that holds all the aura data (aura name, aura display, aura rarity etc.....)
    // then we could have a table which will hold all aura obtainments
    // id, aura_id, user_id, timestamp
    // then we could build a command to list all user auras, etc.........
    commands: [giveAuraCommand],
    events: {
        async messageCreate(_client, message) { // this event happens on EVERY message the bot detects
            if (message.author.bot) return;

            const guild = message.guild?.name ?? "DM";
            const channel = "name" in message.channel ? `#${message.channel.name}` : message.channel.id;

            logger.debug(`[${guild}] [${channel}] ${message.author.username}: ${message.content}`);
        },
    },
});
