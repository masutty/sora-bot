import { Message } from "discord.js";
import { query } from "../../../database/connection";
import { refreshUserActivity } from "../tasks/status_task";
import { Logger } from "@/utils/logging";

const logger = new Logger("biomehunter:ActivityProcessor");

/* ───────────────────────────────────────────── */
/* Types                                        */
/* ───────────────────────────────────────────── */

export interface UserStateDelta {
    userId: string;
    guildId: string;
    lastActivity: Date;
    biomeDeltas: Record<string, number>;
    messageCount: number;
    dirty: boolean;
}

interface ChannelIndexRow {
    dedicated_channel_id: string;
    user_id: string;
    guild_id: string;
}

/* ───────────────────────────────────────────── */
/* ActivityProcessor                            */
/* ───────────────────────────────────────────── */

export class ActivityProcessor {
    // Populated at startup via loadChannelIndex(), and kept in sync
    // by registerChannel() when /bh setup creates a new channel.
    // channelId → { userId, guildId }
    private static channelIndex = new Map<string, { userId: string; guildId: string }>();

    // Shared hot cache — exposed publicly so DbFlushTask can drain it.
    // Never written to by anyone except process().
    static readonly hotCache = new Map<string, UserStateDelta>();

    /* ─────────────────────────────────────────── */
    /* Startup                                    */
    /* ─────────────────────────────────────────── */

    /**
     * Loads all macro channels from the DB into the in-memory index.
     * Must be called in onReady before messageCreate events are processed.
     */
    static async loadChannelIndex(): Promise<void> {
        const result = await query<ChannelIndexRow>(
            `
            SELECT dedicated_channel_id, user_id, guild_id
            FROM bh_user_profiles
            `,
        );

        for (const row of result.rows) {
            this.channelIndex.set(row.dedicated_channel_id, {
                userId: row.user_id,
                guildId: row.guild_id,
            });
        }
    }

    /* ─────────────────────────────────────────── */
    /* Runtime registration                       */
    /* ─────────────────────────────────────────── */

    /**
     * Registers a newly created macro channel into the index.
     * Call this at the end of /bh setup after the DB insert.
     */
    static registerChannel(
        channelId: string,
        userId: string,
        guildId: string,
    ): void {
        this.channelIndex.set(channelId, { userId, guildId });
    }

    /* ─────────────────────────────────────────── */
    /* Hot path                                   */
    /* ─────────────────────────────────────────── */

    /**
     * Called on every messageCreate.
     * Webhook messages have author.bot = true and no author.id matching a real user —
     * channel index lookup is the authoritative filter here.
     * No DB calls; all state is accumulated in hotCache and flushed by DbFlushTask.
     */
    static process(message: Message): void {
        logger.debug(`Processing message in <#${message.channelId}>`);
        const entry = this.channelIndex.get(message.channelId);
        if (!entry) return;

        const biome = this.parseBiome(message.content);
        const key = `${entry.guildId}:${entry.userId}`;

        const cached = this.hotCache.get(key) ?? {
            userId: entry.userId,
            guildId: entry.guildId,
            lastActivity: new Date(),
            biomeDeltas: {},
            messageCount: 0,
            dirty: false,
        };

        cached.lastActivity = new Date();
        cached.messageCount++;
        cached.dirty = true;

        if (biome) {
            cached.biomeDeltas[biome] = (cached.biomeDeltas[biome] ?? 0) + 1;
        }

        this.hotCache.set(key, cached);

        // Notify the StateEngine heap so GREEN is re-scheduled immediately,
        // without waiting for the next DB flush.
        refreshUserActivity(entry.userId, entry.guildId);
    }

    /* ─────────────────────────────────────────── */
    /* Biome parsing                              */
    /* ─────────────────────────────────────────── */

    private static parseBiome(content: string): string | null {
        const match = content.match(/biome[:\s]+([A-Za-z\s]+)/i);
        return match ? match[1].trim() : null;
    }
}
