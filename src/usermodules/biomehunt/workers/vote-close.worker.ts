import type { BotClient } from "@/core/bot-client";
import { defineWorker } from "@/define";
import { closeDueVotes } from "../services/biome-vote.service";
import { settings } from "../settings";

/**
 * Every 5s, resolves every rare-biome community vote whose 1-minute window has elapsed - also
 * covers a vote left `open` by a restart, since nothing about it lives in memory anymore.
 */
export const voteCloseWorker = defineWorker({
    name: "vote-close",
    intervalMs: settings.workers.voteCloseTickMs,
    run: (client: BotClient) => closeDueVotes(client),
});
