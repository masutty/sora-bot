import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type MessageCreateOptions } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { NO_PINGS } from "@/utils/format";
import { Logger } from "@/utils/logging";
import { getOrCreateGuildConfig } from "../repository/guilds.repository";
import { type GuildLogEntry, guildLog } from "./guild-log.service";

const logger = new Logger("biomehunt.services.auto-delete-notice");

const REASON = "> **Reason:** Automatically deleted due to inactivity";
const MAX_LABEL = 80;

export interface AutoDeleteTarget {
    guildId: string;
    discordUserId: string;
    hardWipe: boolean;
}

/** Discord access, injected so tests use none. */
export interface AutoDeleteNoticeDeps {
    sendDm(discordUserId: string, payload: MessageCreateOptions): Promise<void>;
    guildName(guildId: string): string;
    /** Posts to the guild log channel. Resolves false when the guild has none. */
    postGuildLog(guildId: string, entry: GuildLogEntry): Promise<boolean>;
    log(message: string): void;
}

export function defaultAutoDeleteNoticeDeps(client: BotClient): AutoDeleteNoticeDeps {
    return {
        sendDm: async (discordUserId, payload) => {
            const user = await client.users.fetch(discordUserId);
            await user.send(payload);
        },
        guildName: (guildId) => client.guilds.cache.get(guildId)?.name ?? "Unknown server",
        postGuildLog: async (guildId, entry) => {
            if (!(await getOrCreateGuildConfig(guildId)).log_channel_id) return false;
            await guildLog(client, guildId, entry);
            return true;
        },
        log: (message) => logger.warn(message),
    };
}

export interface AutoDeleteDm extends MessageCreateOptions {
    embeds: [EmbedBuilder];
    components: [ActionRowBuilder<ButtonBuilder>];
}

export function buildAutoDeleteDm(guildName: string, guildId: string, hardWipe: boolean): AutoDeleteDm {
    const description = hardWipe
        ? `${REASON}\n> Your badges, history and quota progress were cleared with it.\n\n> Run \`/bh setup\` to start over.`
        : `${REASON}\n\n> Run \`/bh setup\` to get a new one.`;
    const embed = new EmbedBuilder()
        .setColor(hardWipe ? 0xda373c : 0xf0b232)
        .setTitle("Your macro channel was deleted")
        .setDescription(description);
    const button = new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel(`Sent from | ${guildName}`.slice(0, MAX_LABEL))
        .setURL(`https://discord.com/channels/${guildId}`);
    return { embeds: [embed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)], allowedMentions: NO_PINGS };
}

function safeLog(deps: AutoDeleteNoticeDeps, message: string): void {
    try {
        deps.log(message);
    } catch {
        // Nothing left to do: the notice must never break the auto-delete.
    }
}

/** DMs the member about the deleted channel; falls back to the guild log, then the logger. Never throws. */
export async function notifyAutoDelete(target: AutoDeleteTarget, deps: AutoDeleteNoticeDeps): Promise<void> {
    const { guildId, discordUserId, hardWipe } = target;
    try {
        await deps.sendDm(discordUserId, buildAutoDeleteDm(deps.guildName(guildId), guildId, hardWipe));
        return;
    } catch (err) {
        safeLog(deps, `Could not DM ${discordUserId} about the auto-delete: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
        const posted = await deps.postGuildLog(guildId, {
            kind: "warning",
            title: "Auto-delete",
            body: `Deleted the macro channel of <@${discordUserId}> for inactivity. I couldn't DM them.`,
        });
        if (!posted) safeLog(deps, `No log channel in ${guildId} to report the failed auto-delete DM to ${discordUserId}`);
    } catch (err) {
        safeLog(deps, `Could not post the auto-delete warning for ${discordUserId}: ${err instanceof Error ? err.message : String(err)}`);
    }
}
