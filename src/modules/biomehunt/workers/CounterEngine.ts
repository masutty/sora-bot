import { ChannelType, EmbedBuilder } from "discord.js";
import type { BotClient } from "@/core/BotClient";
import { Logger } from "@/utils/logging";
import { getGuildsWithCounterEnabled, setCounterMessageId } from "../repository/guilds";
import { getGuildUserCounts } from "../repository/users";
import type { GuildConfigRow } from "../types";

const logger = new Logger("biomehunt.CounterEngine");

const TICK_INTERVAL_MS = 5 * 60 * 1000;

function buildCounterEmbed(counts: Record<"active" | "idle" | "inactive", number>): EmbedBuilder {
    return new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("Macro Activity Counter")
        .setDescription(`-# Last updated: <t:${Math.floor(Date.now() / 1000)}:R>`)
        .addFields(
            { name: `🟢 \`${String(counts.active)}\``, value: "Active", inline: true },
            { name: `🟡 \`${String(counts.idle)}\``, value: "Idle", inline: true },
            { name: `🔴 \`${String(counts.inactive)}\``, value: "Inactive", inline: true },
        )
}

/** Updates (or creates) the live counter message for a single guild. Guild must have `counter_channel_id` set. */
export async function updateCounterForGuild(client: BotClient, guildConfig: GuildConfigRow): Promise<void> {
    if (!guildConfig.counter_channel_id) throw new Error(`Guild ${guildConfig.guild_id} has no counter channel configured`);

    const channel = await client.channels.fetch(guildConfig.counter_channel_id);
    if (channel?.type !== ChannelType.GuildText) throw new Error(`Counter channel for guild ${guildConfig.guild_id} isn't a text channel`);

    const counts = await getGuildUserCounts(guildConfig.guild_id);
    const embed = buildCounterEmbed(counts);

    let updated = false;
    if (guildConfig.counter_message_id) {
        try {
            const existing = await channel.messages.fetch(guildConfig.counter_message_id);
            await existing.edit({ embeds: [embed] });
            updated = true;
        } catch {
            updated = false;
        }
    }

    if (!updated) {
        const sent = await channel.send({ embeds: [embed] });
        await setCounterMessageId(guildConfig.guild_id, sent.id);
    }
}

async function tick(client: BotClient): Promise<void> {
    const guilds = await getGuildsWithCounterEnabled();

    for (const guildConfig of guilds) {
        if (!guildConfig.counter_channel_id) continue;

        try {
            logger.debug(`Updating counter for guild ${guildConfig.guild_id}`);
            await updateCounterForGuild(client, guildConfig);
        } catch (err) {
            logger.error(err instanceof Error ? err : new Error(String(err)), { guild: guildConfig.guild_id });
        }
    }
}

export function startCounterEngine(client: BotClient): void {
    setInterval(() => {
        tick(client).catch((err) => logger.error(err instanceof Error ? err : new Error(String(err))));
    }, TICK_INTERVAL_MS);
    logger.info(`Counter engine started (tick every ${TICK_INTERVAL_MS}ms)`);
}
