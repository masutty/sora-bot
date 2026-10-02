import type { BotClient } from "@/core/bot-client";
import { defineWorker } from "@/define";
import { closeDueNetworkVotes, defaultNetworkVoteDeps } from "../services/network-vote.service";
import { settings } from "../settings";

/**
 * Every 5s, closes every Network vote whose minute (counted from the last Mirror) is up - also covers
 * a vote left open by a restart, since nothing about it lives in memory.
 */
export const networkVoteCloseWorker = defineWorker({
    name: "network-vote-close",
    intervalMs: settings.workers.networkVoteCloseTickMs,
    run: (client: BotClient) => closeDueNetworkVotes(defaultNetworkVoteDeps(client)),
});
