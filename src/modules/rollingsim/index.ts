import { defineCog, defineCommand } from "@/define";
import { Logger } from "@/utils/logging";

import { ROLLING_SIM_SCHEMA } from "./migrations";
import RollingService from "./services/RollingSimulator";
import AuraService from "./services/Aura";
import ItemService from "./services/Item";

const logger = new Logger("RollingSim");

const command = defineCommand({
    name: "rs_testcmd",
    description: "rs_testcmd",
    botOwnerOnly: true,
    showOnHelp: false,

    async executeAsPrefix(message, args) {
        const auras = await AuraService.listAllAuras();
        const items = await ItemService.listAllItems();
        logger.debug(`Auras: ${auras}`);
        logger.debug(`Items: ${items}`);
    }
})


export default defineCog({
    name: "rollingsim",
    description: "Passive rolling simulator",
    authors: [{ name: "masutty", id: 188851299255713792n }],

    commands: [command],

    migrations: [
        ROLLING_SIM_SCHEMA,
    ],

    events: {
        async messageCreate(_client, message) {
            const author = message.author;

            if (author.bot) return;
            if (!message.guild) return;

            await RollingService.process(message);
        },
    },
});
