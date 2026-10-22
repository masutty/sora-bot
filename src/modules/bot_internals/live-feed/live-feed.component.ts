import { MessageFlags } from "discord.js";
import { config } from "@/config";
import { defineComponent } from "@/define";
import { logBuffer } from "@/utils/log-buffer";
import { Logger } from "@/utils/logging";
import { LIVE_FEED_NAMESPACE } from "./constants";
import { type LiveFeedController, liveFeed } from "./live-feed";
import { buildClosedPayload, LIVE_FEED_PREFIX } from "./render";

const logger = new Logger(LIVE_FEED_NAMESPACE);

/** Injected so tests never touch the real feed, config or log buffer. */
export interface LiveFeedComponentDeps {
    ownerIds(): readonly string[];
    feed: Pick<LiveFeedController, "activeId" | "extend" | "stop">;
    /** Raw buffered log text - no redaction, so it must only ever reach an owner. */
    bufferText(): string;
}

export function defaultLiveFeedComponentDeps(): LiveFeedComponentDeps {
    return {
        ownerIds: () => config.bot.ownerIds,
        feed: liveFeed,
        bufferText: () =>
            logBuffer
                .entries()
                .map((e) => e.text)
                .join("\n"),
    };
}

/**
 * `bot_internals:livefeed:<feedId>:<stop|extend|buffer>` - the buttons on the live log feed. Only a
 * bot owner may click: the Buffer button returns raw, unredacted logs. The owner check runs first
 * and fails closed (a throwing config read denies).
 */
export function liveFeedComponent(deps: LiveFeedComponentDeps = defaultLiveFeedComponentDeps()) {
    return defineComponent({
        prefix: LIVE_FEED_PREFIX,
        handle: async (interaction, parts) => {
            if (!interaction.isButton()) return;

            const [feedId, action] = parts;
            let isOwner: boolean;
            try {
                isOwner = deps.ownerIds().includes(interaction.user.id);
            } catch {
                isOwner = false;
            }
            if (!isOwner) {
                if (action === "buffer") logger.warn(`Non-owner ${interaction.user.id} tried to download the log buffer`);
                await interaction.reply({ content: "Only bot developers can use this.", flags: MessageFlags.Ephemeral });
                return;
            }

            // A click on a feed that already ended (or was replaced): clean the orphan message up.
            if (!feedId || feedId !== deps.feed.activeId()) {
                await interaction.update(buildClosedPayload("closed"));
                return;
            }

            if (action === "stop") {
                await interaction.deferUpdate();
                await deps.feed.stop(feedId, "stopped");
            } else if (action === "extend") {
                await interaction.deferUpdate();
                await deps.feed.extend(feedId);
            } else if (action === "buffer") {
                await interaction.reply({
                    files: [{ attachment: Buffer.from(deps.bufferText()), name: `sora-log-buffer-${new Date().toISOString()}.txt` }],
                    flags: MessageFlags.Ephemeral,
                });
            } else {
                await interaction.deferUpdate();
            }
        },
    });
}
