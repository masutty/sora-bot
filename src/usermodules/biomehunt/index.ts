import { defineCog } from "@/define";
import { Logger } from "@/utils/logging";
import _admin from "./commands/admin.command";
import _bh from "./commands/bh.command";
import _manageMember from "./commands/manage-member.command";
import _network from "./commands/network.command";
import _networkAdmin from "./commands/network-admin.command";
import _owner from "./commands/owner.command";
import _profile from "./commands/profile.command";
import _reroll from "./commands/reroll.command";
import _stats from "./commands/stats.command";
import { biomeVoteComponent } from "./components/biome-vote.component";
import { forwardInfoComponent } from "./components/forward-info.component";
import { networkReviewComponent } from "./components/network-review.component";
import { networkVoteComponent } from "./components/network-vote.component";
import { BIOMEHUNT_SCHEMA } from "./migrations";
import { loadBiomeRegistry, seedDefaultBiomes } from "./repository/biomes.repository";
import { loadChannelIndex } from "./repository/users.repository";
import { processIncomingMessage } from "./services/activity.service";
import { counterWorker } from "./workers/counter.worker";
import { networkDailyWorker } from "./workers/network-daily.worker";
import { networkPublishWorker } from "./workers/network-publish.worker";
import { networkVoteCloseWorker } from "./workers/network-vote-close.worker";
import { roleWorker } from "./workers/role.worker";
import { statusWorker } from "./workers/status.worker";
import { voteCloseWorker } from "./workers/vote-close.worker";

const logger = new Logger("biomehunt");

export default defineCog({
    name: "biomehunt",
    description: "Tracks macro-driven activity, enforces quotas, and automates roles.",
    authors: [{ name: "masutty", id: 188851299255713792n }],

    commands: [_bh, _admin, _owner, _stats, _profile, _reroll, _manageMember, _network, _networkAdmin],

    migrations: [BIOMEHUNT_SCHEMA],

    workers: [statusWorker, roleWorker, counterWorker, voteCloseWorker, networkPublishWorker, networkVoteCloseWorker, networkDailyWorker],

    components: [biomeVoteComponent(), forwardInfoComponent(), networkReviewComponent(), networkVoteComponent()],

    events: {
        async messageCreate(_client, message) {
            if (!message.guild) return;
            if (!message.webhookId) return;
            await processIncomingMessage(message).catch((err) => {
                logger.error(err instanceof Error ? err : new Error(String(err)));
            });
        },
    },

    async onReady(_client) {
        logger.info("Loading biome registry...");
        await seedDefaultBiomes();
        await loadBiomeRegistry();

        logger.info("Loading channel index...");
        await loadChannelIndex();

        logger.info("Biome Hunt ready.");
    },
});
