import type { Message } from "discord.js";
import { config } from "@/config";
import { isKnownMacro, isMerchantReport } from "../macro-parsers";
import { isFlagEnabled } from "../repository/flags.repository";
import { getOrCreateGuildConfig } from "../repository/guilds.repository";
import {
    type ChannelIndexEntry,
    claimMacroWarning,
    getUserById,
    recordUnreadEmbed,
    releaseMacroWarning,
    resetUnreadEmbeds,
} from "../repository/users.repository";
import { settings } from "../settings";
import type { ParsedEvent } from "../types";
import { macroWarningPayload } from "../views/macro-warning.view";

export interface MacroHealthDeps {
    resetUnreadEmbeds: typeof resetUnreadEmbeds;
    recordUnreadEmbed: typeof recordUnreadEmbed;
    claimMacroWarning: typeof claimMacroWarning;
    releaseMacroWarning: typeof releaseMacroWarning;
    isFlagEnabled: typeof isFlagEnabled;
    sessionGapS: (guildId: string) => Promise<number>;
    discordUserId: (userId: number) => Promise<string | null>;
    ownerIds: readonly string[];
}

function defaultMacroHealthDeps(): MacroHealthDeps {
    return {
        resetUnreadEmbeds,
        recordUnreadEmbed,
        claimMacroWarning,
        releaseMacroWarning,
        isFlagEnabled,
        sessionGapS: async (guildId) => (await getOrCreateGuildConfig(guildId)).session_gap_threshold_s,
        discordUserId: async (userId) => (await getUserById(userId))?.discord_user_id ?? null,
        ownerIds: config.bot.ownerIds,
    };
}

/**
 * Warns a member whose macro keeps posting while neither a biome start/end nor a merchant report is
 * read from it. A recognized macro is failing; an unrecognized one is incompatible.
 */
export async function trackMacroHealth(
    message: Message,
    entry: ChannelIndexEntry,
    parsed: ParsedEvent | null,
    deps: MacroHealthDeps = defaultMacroHealthDeps(),
): Promise<void> {
    // Plain text isn't a macro report.
    if (message.embeds.length === 0 && message.components.length === 0) return;

    // A biome without an event type (thumbnail only) is not enough: stats never count it.
    if (parsed?.eventType || isMerchantReport(message)) {
        await deps.resetUnreadEmbeds(entry.userId);
        return;
    }

    await deps.recordUnreadEmbed(entry.userId, await deps.sessionGapS(entry.guildId));
    if (!(await deps.isFlagEnabled(entry.guildId, "WARN_MACRO_PROBLEMS"))) return;
    const { minUnreadEmbeds, minSpanS } = settings.macroWarning;
    if (!(await deps.claimMacroWarning(entry.userId, minUnreadEmbeds, minSpanS))) return;

    try {
        const memberId = await deps.discordUserId(entry.userId);
        if (!memberId || !message.channel.isSendable()) throw new Error("Could not send the incompatible macro warning");
        await message.channel.send(macroWarningPayload(isKnownMacro(message) ? "failing" : "incompatible", memberId, deps.ownerIds));
    } catch (err) {
        await deps.releaseMacroWarning(entry.userId);
        throw err;
    }
}
