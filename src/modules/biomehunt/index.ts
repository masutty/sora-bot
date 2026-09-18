import { defineCog } from "@/define";
import { Logger } from "@/utils/logging";
import { backfillMissingFlowers } from "./guildSetup";
import { BIOMEHUNT_SCHEMA } from "./migrations";
import { loadChannelIndex } from "./repository/users";
import { processIncomingMessage } from "./services/ActivityEngine";
import { handleVoteButtonClick } from "./services/VoteCheckEngine";
import { startCounterEngine } from "./workers/CounterEngine";
import { startRoleEngine } from "./workers/RoleEngine";
import { startStatusEngine } from "./workers/StatusEngine";
import _bh from "./commands/bh";
import _bhAdmin from "./commands/bh-admin";
import _bhOwner from "./commands/bh-owner";

const logger = new Logger("biomehunt");

export default defineCog({
    name: "biomehunt",
    description: "Tracks macro-driven activity, enforces quotas, and automates roles.",
    authors: [{ name: "masutty", id: 188851299255713792n }],

    commands: [_bh, _bhAdmin, _bhOwner],

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

        await backfillMissingFlowers(client).catch((err) => {
            logger.error(err instanceof Error ? err : new Error(String(err)));
        });

        logger.info("Starting workers...");
        startStatusEngine(client);
        startRoleEngine(client);
        startCounterEngine(client);

        logger.info("BiomeHunt ready.");
    },
});
