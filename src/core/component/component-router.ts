/**
 * `defineComponent` - persistent components: buttons/selects on a message that outlives any View
 * session (e.g. after a bot restart). A cog declares WHAT it owns (a customId prefix) and how to
 * handle a click; the router owns matching a click to its owner and running it in a trace - a
 * module never listens for `interactionCreate` itself for this.
 */
import { type MessageComponentInteraction, MessageFlags } from "discord.js";
import { Logger } from "@/utils/logging";
import { newTraceRef, runWithTrace } from "@/utils/trace";
import type { BotClient } from "../bot-client";

const logger = new Logger("core.component");

/**
 * A persistent component, declared with `defineComponent`. A cog lists these in `components: [...]`
 * (see `Cog.components`); the cog loader routes every button/select interaction to the one owning
 * its customId.
 */
export interface ComponentDefinition {
    /**
     * The customId prefix this component owns - must be `<cog>:<feature>` (checked when the cog
     * loads: `<cog>` must be this component's own cog's name - a typo'd prefix fails the load
     * instead of silently never routing). Routes any interaction whose customId starts with
     * `prefix + ":"`.
     */
    prefix: string;
    /**
     * Fixed legacy customIds this component still answers to, matched by EXACT equality (never as
     * a prefix) - e.g. a bare pre-`defineComponent` button id with no dynamic `:`-segments at all,
     * so a component already out on an old message doesn't dead-end forever. Routed to the same
     * `handle`, with an empty `parts` array; NOT checked against the cog name (may predate it).
     */
    legacyIds?: string[];
    /** `parts`: the customId's `:`-separated segments after the matched prefix. */
    handle: (interaction: MessageComponentInteraction, parts: string[], client: BotClient) => void | Promise<void>;
}

/** Declares a component - see `ComponentDefinition`. */
export function defineComponent(def: ComponentDefinition): ComponentDefinition {
    return def;
}

/**
 * Throws if `def.prefix` doesn't start with `<cogName>:` - called when a cog loads.
 */
export function validateComponentPrefix(cogName: string, def: ComponentDefinition): void {
    const required = `${cogName}:`;
    if (!def.prefix.startsWith(required)) {
        throw new Error(`Component prefix "${def.prefix}" must start with "${required}" (its own cog's name)`);
    }
}

/**
 * The component (and its `parts`) that owns `customId` - `undefined` if none does. `prefix`
 * matches as `prefix + ":"` (an id that merely starts with a bare prefix, no `:` after it, does
 * NOT match); each `legacyIds` entry matches only by EXACT equality to the whole `customId`, never
 * as a prefix, and always yields an empty `parts` array.
 */
export function matchComponent(
    components: ComponentDefinition[],
    customId: string,
): { component: ComponentDefinition; parts: string[] } | undefined {
    for (const component of components) {
        const marker = `${component.prefix}:`;
        if (customId.startsWith(marker)) {
            return { component, parts: customId.slice(marker.length).split(":") };
        }
        if (component.legacyIds?.includes(customId)) {
            return { component, parts: [] };
        }
    }
    return undefined;
}

/**
 * Routes one button/select interaction: matches its customId against every loaded cog's
 * components and, on a hit, runs `handle` inside `runWithTrace({ ref: newTraceRef(), command:
 * "component:<prefix>", userId, userTag, guildId })`. A throw/rejection from `handle` is logged,
 * not re-thrown - routing keeps working for the next interaction. An id nothing owns is silently
 * ignored (no log, no throw). Returns whether something handled it (informational only).
 */
export async function dispatchComponent(
    client: BotClient,
    interaction: MessageComponentInteraction,
): Promise<boolean> {
    for (const cog of client.cogs.values()) {
        const found = matchComponent(cog.components ?? [], interaction.customId);
        if (!found) continue;

        const { component, parts } = found;
        await runWithTrace(
            {
                ref: newTraceRef(),
                command: `component:${component.prefix}`,
                userId: interaction.user.id,
                userTag: interaction.user.username,
                guildId: interaction.guildId ?? undefined,
            },
            async () => {
                try {
                    await component.handle(interaction, parts, client);
                } catch (err) {
                    logger.error(err instanceof Error ? err : new Error(String(err)), { component: component.prefix });
                    // Best-effort only, and only if `handle` never answered the interaction itself
                    // (e.g. it deferred/replied before throwing) - a reply() on an already-answered
                    // interaction would itself throw, on top of the original failure.
                    if (!interaction.replied && !interaction.deferred) {
                        await interaction
                            .reply({ content: "Something went wrong.", flags: MessageFlags.Ephemeral })
                            .catch(() => {});
                    }
                }
            },
        );
        return true;
    }
    return false;
}
