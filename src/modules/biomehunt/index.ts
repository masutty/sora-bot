import { defineCog } from "@/define";
import { Logger } from "@/utils/logging";

import { BIOME_HUNTER_SCHEMA } from "./migrations";
import { ActivityProcessor } from "./services/ActivityProcessor";
import { RoleManager } from "./services/RoleManager";
import { startStatusTask, registerUser } from "./tasks/status_task";
import { startCounterTask } from "./tasks/counter_task";
import { DbFlushTask } from "./tasks/db_flush_task";

import _bh from "./commands/bh";
import _bhAdmin from "./commands/bh-admin";

// import { setupCommand } from "./commands/setup";
// import { webhookCommand } from "./commands/webhook";
// import { profileCommand } from "./commands/profile";
// import { setGreenCommand } from "./admin/setGreen";
// import { setYellowCommand } from "./admin/setYellow";
// import { setRedCommand } from "./admin/setRed";
// import { setCountCommand } from "./admin/setCount";
// import { summaryCommand } from "./admin/summary";

const logger = new Logger("biomehunt");

export { registerUser };

export default defineCog({
    name: "biomehunt",
    description: "Biome hunting tracker and activity monitor",
    authors: [{ name: "masutty", id: 188851299255713792n }],

    commands: [
        _bh, _bhAdmin
    ],

    migrations: [BIOME_HUNTER_SCHEMA],

    async onReady(client) {
        logger.info("Starting background tasks...");

        // Populate channel index before any messageCreate fires
        logger.debug("Loading channel index...");
        await ActivityProcessor.loadChannelIndex();

        // Give RoleManager access to the client, then start draining its queue
        logger.debug("Initializing RoleManager...");
        RoleManager.init(client);
        setInterval(() => RoleManager.drain(), 200);

        // hotCache is owned by ActivityProcessor and shared with DbFlushTask
        logger.debug("Initializing hotCache...");
        DbFlushTask.start(ActivityProcessor.hotCache);

        logger.debug("Starting status task...");
        await startStatusTask();
        startCounterTask(client);

        logger.info("BiomeHunter ready.");
    },

    events: {
        // Webhook messages arrive as bot messages — author.bot check would
        // discard all of them. Channel index lookup is the real filter.
        async messageCreate(_client, message) {
            if (!message.guild) return;
            if (!message.author.bot) return;

            logger.debug(`[${message.guild.name}] [<#${message.channel.id}>] ${message.author.username}: ${message.content}`);

            ActivityProcessor.process(message);
        },
    },
});
