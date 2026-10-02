import type { BotClient } from "@/core/bot-client";
import { defineWorker } from "@/define";
import { runNetworkDaily } from "../services/network-daily.service";
import { settings } from "../settings";

/**
 * Hourly: the once-a-day activity check of every Member Server (each guild remembers the day it was
 * last checked) and, from `digestHourUtc` on, the daily Multi Macro digest DM.
 */
export const networkDailyWorker = defineWorker({
    name: "network-daily",
    intervalMs: settings.workers.networkDailyTickMs,
    runOnStart: true,
    run: (client: BotClient) => runNetworkDaily(client),
});
