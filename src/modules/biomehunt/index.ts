import { defineCog } from "@/define";
import { Logger } from "@/utils/logging";
import _bh from "./commands/bh.command";
import _bhAdmin from "./commands/bh-admin.command";
import _bhOwner from "./commands/bh-owner.command";
import _bhStats from "./commands/bh-stats.command";
import { BIOMEHUNT_SCHEMA } from "./migrations";
import { loadChannelIndex } from "./repository/users.repository";
import { processIncomingMessage } from "./services/activity-ingest.service";
import { handleVoteButtonClick } from "./services/vote-check.service";
import { startCounterWorker } from "./workers/counter.worker";
import { startRoleWorker } from "./workers/role.worker";
import { startStatusWorker } from "./workers/status.worker";

const logger = new Logger("biomehunt");

export default defineCog({
    name: "biomehunt",
    description: "Tracks macro-driven activity, enforces quotas, and automates roles.",
    authors: [{ name: "masutty", id: 188851299255713792n }],

    commands: [_bh, _bhAdmin, _bhOwner, _bhStats],

    migrations: [BIOMEHUNT_SCHEMA],

    events: {
        async messageCreate(_client, message) {
            if (!message.guild) return;
            if (!message.webhookId) return;
            await processIncomingMessage(message).catch((err) => {
                logger.error(err instanceof Error ? err : new Error(String(err)));
            });
        },
        async interactionCreate(client, interaction) {
            await handleVoteButtonClick(client, interaction).catch((err) => {
                logger.error(err instanceof Error ? err : new Error(String(err)));
            });
        },
    },

    async onReady(client) {
        logger.info("Loading channel index...");
        await loadChannelIndex();

        logger.info("Starting workers...");
        startStatusWorker(client);
        startRoleWorker(client);
        startCounterWorker(client);

        logger.info("BiomeHunt ready.");
    },
});
