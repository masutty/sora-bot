import { type MessageComponentInteraction, MessageFlags } from "discord.js";
import { NO_PINGS } from "@/utils/format";
import { Logger } from "@/utils/logging";
import type { ViewPayload } from "./view";
import { stripInteractive, toJsonList } from "./view-engine";

const logger = new Logger("core.view.orphan");

const EXPIRED = "This menu expired. Run the command again.";

/**
 * Messages a View session is listening on, counted (a new View may take over a message before
 * the old session closes). A View's clicks reach it through its own collector; the component
 * router only answers a click when no session listens on its message.
 */
const listening = new Map<string, number>();

export function markViewListening(messageId: string): void {
    listening.set(messageId, (listening.get(messageId) ?? 0) + 1);
}

export function markViewClosed(messageId: string): void {
    const n = (listening.get(messageId) ?? 0) - 1;
    if (n > 0) listening.set(messageId, n);
    else listening.delete(messageId);
}

export function hasLiveView(messageId: string): boolean {
    return listening.has(messageId);
}

/** The slice of a discord.js MessageComponentInteraction that `answerOrphanClick` uses. */
export type OrphanClick = Pick<MessageComponentInteraction, "customId" | "update" | "reply" | "followUp"> & {
    message: { components: unknown[] };
};

/**
 * Answers a click nothing listens to - a View whose session died with the process (a restart or
 * deploy keeps its message, buttons included), or a component no cog owns anymore. Without this,
 * Discord shows "This interaction failed" on every click, forever. It strips the dead controls
 * from the message (Link buttons stay) and tells the clicker the menu expired.
 */
export async function answerOrphanClick(i: OrphanClick): Promise<void> {
    logger.info(`click on a dead menu: ${i.customId}`);
    const components = stripInteractive(toJsonList(i.message.components as ViewPayload["components"]));
    const note = { content: EXPIRED, flags: MessageFlags.Ephemeral as const, allowedMentions: NO_PINGS };
    // An edit Discord rejects (e.g. a Components V2 message left with nothing) still gets the note.
    const stripped = await i.update({ components } as never).then(
        () => true,
        () => false,
    );
    await (stripped ? i.followUp(note) : i.reply(note)).catch((err: unknown) =>
        logger.warn(`couldn't answer a dead menu click: ${err instanceof Error ? err.message : String(err)}`),
    );
}
