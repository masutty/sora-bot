import { type Message, PermissionFlagsBits } from "discord.js";
import { UserFacingError } from "@/define";

export const CLEAR_WINDOW_MS = 10 * 60 * 1000;

/** The channel calls `clearCommandMessages` needs. */
export interface ClearChannel {
    /** discord.js returns a Collection (a Map of id -> Message), so only its `values()` are read. */
    messages: { fetch(options: { limit: number }): Promise<{ values(): Iterable<Message> }> };
    bulkDelete(ids: string[], filterOld: boolean): Promise<{ size: number }>;
}

/** Throws a UserFacingError unless the bot's permissions in the channel include Manage Messages. */
export function assertBotCanClear(permissions: { has(permission: bigint): boolean } | null | undefined): void {
    if (!permissions?.has(PermissionFlagsBits.ManageMessages)) throw new UserFacingError("I need Manage Messages here.");
}

/**
 * Deletes, among the last 100 messages of the last 10 minutes, the prefix invocations of `commandNames`
 * by anyone and the bot's replies to them. Returns how many messages were deleted.
 */
export async function clearCommandMessages(
    channel: ClearChannel,
    opts: { prefix: string; commandNames: ReadonlySet<string>; botId: string; now: number },
): Promise<number> {
    const fetched = await channel.messages.fetch({ limit: 100 });
    const recent = [...fetched.values()].filter((m) => m.createdTimestamp >= opts.now - CLEAR_WINDOW_MS);
    const invocations = recent.filter((m) => {
        if (m.author.bot || !m.content.startsWith(opts.prefix)) return false;
        const name = m.content.slice(opts.prefix.length).trim().split(/\s+/)[0]?.toLowerCase() ?? "";
        return opts.commandNames.has(name);
    });
    const ids = new Set(invocations.map((m) => m.id));
    const replies = recent.filter((m) => m.author.id === opts.botId && m.reference?.messageId && ids.has(m.reference.messageId));
    const targets = [...invocations, ...replies].map((m) => m.id);
    if (targets.length === 0) return 0;
    return (await channel.bulkDelete(targets, true)).size;
}
