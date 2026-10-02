import type { BotClient } from "@/core/bot-client";
import { defineWorker } from "@/define";
import { defaultNetworkPublishDeps, publishDuePosts } from "../services/network-publish.service";
import { settings } from "../settings";

/**
 * Every 2s, sends every Network Post whose time has come (the origin's local post plus the home
 * advantage). Pending posts live in the database, so a restart only delays them - a post more than
 * 2 minutes late is discarded instead of sent.
 */
export const networkPublishWorker = defineWorker({
    name: "network-publish",
    intervalMs: settings.workers.networkPublishTickMs,
    run: (client: BotClient) => publishDuePosts(defaultNetworkPublishDeps(client)),
});
