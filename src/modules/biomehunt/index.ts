import { defineCog } from "@/define";
import { Logger } from "@/utils/logging";
import _bh from "./commands/bh.command";
import _bhAdmin from "./commands/bh-admin.command";
import _bhOwner from "./commands/bh-owner.command";
import _bhStats from "./commands/bh-stats.command";
import { biomeVoteComponent } from "./components/biome-vote.component";
import { BIOMEHUNT_SCHEMA } from "./migrations";
import { loadChannelIndex } from "./repository/users.repository";
import { processIncomingMessage } from "./services/activity-ingest.service";
import { counterWorker } from "./workers/counter.worker";
import { roleWorker } from "./workers/role.worker";
import { statusWorker } from "./workers/status.worker";
import { voteCloseWorker } from "./workers/vote-close.worker";

const logger = new Logger("biomehunt");

/** Buttons on a message posted before the DB-backed vote existed - it has no vote row (its state was only ever in memory), so it can never be resolved. */
const LEGACY_VOTE_BUTTON_IDS = new Set(["bh-vote-confirm", "bh-vote-deny"]);

export default defineCog({
    name: "biomehunt",
    description: "Tracks macro-driven activity, enforces quotas, and automates roles.",
    authors: [{ name: "masutty", id: 188851299255713792n }],

    commands: [_bh, _bhAdmin, _bhOwner, _bhStats],

    migrations: [BIOMEHUNT_SCHEMA],

    workers: [statusWorker, roleWorker, counterWorker, voteCloseWorker],

    components: [biomeVoteComponent()],

    events: {
        async messageCreate(_client, message) {
            if (!message.guild) return;
            if (!message.webhookId) return;
            await processIncomingMessage(message).catch((err) => {
                logger.error(err instanceof Error ? err : new Error(String(err)));
            });
        },
        // Not routed through `components:` on purpose - these bare, colon-less customIds predate
        // defineComponent's `prefix + ":"` routing and can never match it. Kept only so a button on
        // an old message answers instead of doing nothing.
        async interactionCreate(_client, interaction) {
            if (!interaction.isButton()) return;
            if (!LEGACY_VOTE_BUTTON_IDS.has(interaction.customId)) return;
            await interaction.reply({ content: "This vote is no longer available.", ephemeral: true }).catch((err) => {
                logger.error(err instanceof Error ? err : new Error(String(err)));
            });
        },
    },

    async onReady(_client) {
        logger.info("Loading channel index...");
        await loadChannelIndex();

        logger.info("BiomeHunt ready.");
    },
});
