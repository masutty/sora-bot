import { defineCog } from "@/define";
import { Logger } from "@/utils/logging";
import stickyCommand from "./commands/sticky.command";
import stickyOwnerCommand from "./commands/sticky-owner.command";
import { createStickyEvents } from "./events";
import { STICKY_SCHEMA } from "./migrations";
import { deleteSticky, listAllStickies } from "./repository/stickies.repository";
import { loadWithRetry } from "./services/boot-load";
import { stickyRuntime } from "./services/runtime";
import { stickyCache } from "./services/sticky-cache";

const logger = new Logger("sticky");

export default defineCog({
    name: "sticky",
    description: "Keeps a message at the bottom of a channel.",
    authors: [{ name: "masutty", id: 188851299255713792n }],

    commands: [stickyCommand, stickyOwnerCommand],

    migrations: [STICKY_SCHEMA],

    events: createStickyEvents({ reposter: (client) => stickyRuntime(client).reposter, deleteRow: deleteSticky }),

    async onReady(_client) {
        // Not awaited: a failing database must not hold the boot for the whole backoff.
        void loadWithRetry({
            load: async () => stickyCache.load(await listAllStickies()),
            sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            logError: (err) => logger.error(err),
            logInfo: (message) => logger.info(message),
        });
    },
});
