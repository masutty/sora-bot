import { Logger } from "@/utils/logging";
import type { BotClient } from "../../../core/BotClient";
import { query } from "../../../database/connection";
import {
    getGuildConfig,
    setGuildConfig,
} from "../services/GuildConfigCache";

const logger = new Logger("biomehunt:counter_task");

/* ───────────────────────────────────────────── */
/* Types                                        */
/* ───────────────────────────────────────────── */

interface StatRow {
    current_state: string;
    count: string;
}

/* ───────────────────────────────────────────── */
/* Helpers                                      */
/* ───────────────────────────────────────────── */

async function fetchStateCounts(
    guildId: string,
): Promise<{ green: number; yellow: number; red: number }> {
    const result = await query<StatRow>(
        `
        SELECT current_state, COUNT(*) AS count
        FROM bh_user_profiles
        WHERE guild_id = $1
        GROUP BY current_state
        `,
        [guildId],
    );

    const counts = { green: 0, yellow: 0, red: 0 };

    for (const row of result.rows) {
        const state = row.current_state as keyof typeof counts;
        if (state in counts) {
            counts[state] = Number(row.count);
        }
    }

    return counts;
}

function buildCounterContent(
    green: number,
    yellow: number,
    red: number,
): string {
    return [
        "## Macro activity status",
        `🟢 **\`${green}\`** Active`,
        `🟡 **\`${yellow}\`** Idle`,
        `🔴 **\`${red}\`** Inactive`,
        ``,
        `-# Last updated: <t:${Math.floor(Date.now() / 1000)}:R>`,
    ].join("\n");
}

/* ───────────────────────────────────────────── */
/* Per-guild update                             */
/* ───────────────────────────────────────────── */

async function updateGuildCounter(
    client: BotClient,
    guildId: string,
): Promise<void> {
    const config = await getGuildConfig(guildId);
    if (!config?.counterChannelId) return;

    const { green, yellow, red } = await fetchStateCounts(guildId);
    const content = buildCounterContent(green, yellow, red);

    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return;

    const channel = await guild.channels.fetch(config.counterChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return;

    // If we already have a message, edit it; otherwise send a new one and persist the ID
    if (config.counterMessageId) {
        const existing = await channel.messages
            .fetch(config.counterMessageId)
            .catch(() => null);

        if (existing) {
            await existing.edit(content);
            return;
        }
    }

    // No message yet (or it was deleted) — send a fresh one and save the ID
    const sent = await channel.send(content);

    await setGuildConfig(guildId, { counterMessageId: sent.id });
}

/* ───────────────────────────────────────────── */
/* Tick — iterates all configured guilds        */
/* ───────────────────────────────────────────── */

interface GuildIdRow {
    guild_id: string;
}

async function tick(client: BotClient): Promise<void> {
    logger.debug("Tick...");
    const result = await query<GuildIdRow>(
        `
        SELECT guild_id
        FROM bh_guild_config
        WHERE counter_channel_id IS NOT NULL
        `,
    );

    for (const { guild_id } of result.rows) {
        logger.debug(`Processing guild ${guild_id}...`);
        await updateGuildCounter(client, guild_id).catch(err => {
            logger.error(`Guild ${guild_id}:`, err);
        });
    }
}

/* ───────────────────────────────────────────── */
/* Start                                        */
/* ───────────────────────────────────────────── */

const INTERVAL_MS = 5 * 60 * 1000; // 5 minutes — safe below Discord's edit rate limit

export function startCounterTask(client: BotClient): void {
    // Run once immediately so the counter is fresh after a restart,
    // then keep the regular interval.
    logger.debug("Starting counter task...");
    tick(client).catch(err => console.error("[CounterTask] initial tick:", err));
    setInterval(() => tick(client), INTERVAL_MS);
    logger.debug("Counter task started! Tick interval: " + INTERVAL_MS + "ms");
}
