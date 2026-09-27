import { ButtonStyle, ContainerBuilder, MessageFlags } from "discord.js";
import { config } from "@/config";
import { defineView, type HandlerContext, type HandlerResult, type StepResult, type ViewDefinition, type ViewPayload } from "@/define";
import { EmbedFormatter, NO_PINGS } from "@/utils/format";
import { formatBiomeName, resolveBiomeSelector } from "../constants/biomes.constants";
import type { BiomeForwardRow } from "../types";
import { forwardCreateView } from "./forward-create.view";
import { forwardRemoveView } from "./forward-remove.view";

/** Whether a `biomehunt.forward-list` closes on its own ("Close" button, standalone `bh-admin forward menu`)
 * or is a step in a bigger flow (Back/Skip/Cancel, driving a `StepResult`). */
export type ForwardListExit = "close" | "step";

/**
 * Everything the View needs that would otherwise be a DB call, injected so its tests never hit it
 * - `runForwardConfigFlow`/`stepBiomeForwards` (`flows/forward-config.flow.ts`) wire the real
 * repository functions.
 */
export interface ForwardListDeps {
    getForwards(guildId: string): Promise<BiomeForwardRow[]>;
    setForward(guildId: string, biome: string, channelId: string, roleId: string | null): Promise<void>;
    removeForward(guildId: string, biome: string): Promise<void>;
}

export interface ForwardListInput {
    guildId: string;
    /** Step mode only - whether Back is enabled (ignored in close mode, where there's no Back). */
    canGoBack?: boolean;
}

interface ForwardListState {
    guildId: string;
    canGoBack: boolean;
    forwards: BiomeForwardRow[];
}

// biome-ignore lint/suspicious/noConfusingVoidType: `void` (not `undefined`) is what lets `close`'s handler call `c.done()` with no argument below.
type ForwardListResult = void | StepResult;

/** `<biome name> - <#channel>` (` (pings <@&role>)` if one is set). Shared with `forward-remove.view.ts`'s numbered list. */
export function formatForwardLine(f: BiomeForwardRow): string {
    return `${formatBiomeName(f.biome)} - <#${f.channel_id}>${f.role_id ? ` (pings <@&${f.role_id}>)` : ""}`;
}

function listContainer(forwards: BiomeForwardRow[]): ContainerBuilder {
    const container = new ContainerBuilder().setAccentColor(0x5865f2);
    container.addTextDisplayComponents((td) =>
        td.setContent(`**Biome Forwards**\n${forwards.length > 0 ? forwards.map(formatForwardLine).join("\n") : "None configured yet."}`),
    );
    return container;
}

/** The list's own Create/Remove handlers - shared by both exit modes. */
function sharedHandlers(deps: ForwardListDeps): Record<"add" | "remove", (c: HandlerContext<ForwardListState, ForwardListResult>) => HandlerResult<ForwardListState>> {
    return {
        add: async (c) => {
            const created = await c.open(forwardCreateView(), undefined);
            if (created) {
                const biomes = resolveBiomeSelector(created.biome);
                for (const biome of biomes) await deps.setForward(c.state.guildId, biome, created.channelId, created.roleId);
            }
            c.state.forwards = await deps.getForwards(c.state.guildId);
        },
        remove: async (c) => {
            const picked = await c.open(forwardRemoveView(), { forwards: c.state.forwards });
            if (picked) await deps.removeForward(c.state.guildId, picked.biome);
            c.state.forwards = await deps.getForwards(c.state.guildId);
        },
    };
}

/**
 * Shared list + Create/Remove screen for biome forwards - `exit: "close"` (a "Close" button, the
 * standalone `bh-admin forward menu`) or `exit: "step"` (Back/Skip/Cancel, driving a `StepResult`
 * for `ez-setup.flow.ts`'s wizard). Both modes share the same list/Create/Remove behavior; only the
 * exit row and what `done` resolves with differ.
 */
export function forwardListView(deps: ForwardListDeps, exit: "close"): ViewDefinition<ForwardListState, void, ForwardListInput>;
export function forwardListView(deps: ForwardListDeps, exit: "step"): ViewDefinition<ForwardListState, StepResult, ForwardListInput>;
export function forwardListView(deps: ForwardListDeps, exit: ForwardListExit): ViewDefinition<ForwardListState, ForwardListResult, ForwardListInput> {
    return defineView<ForwardListState, ForwardListResult, ForwardListInput>({
        name: "biomehunt.forward-list",
        initial: async (input) => ({
            guildId: input.guildId,
            canGoBack: input.canGoBack ?? false,
            forwards: await deps.getForwards(input.guildId),
        }),
        timeoutMs: config.ui.flowStepTimeoutMs,
        render: (state, kit): ViewPayload => ({
            flags: MessageFlags.IsComponentsV2,
            components: [
                listContainer(state.forwards),
                kit.row(
                    kit.button("add", (b) => b.setLabel("Create").setStyle(ButtonStyle.Success)),
                    kit.button("remove", (b) => b.setLabel("Remove").setStyle(ButtonStyle.Danger).setDisabled(state.forwards.length === 0)),
                    ...(exit === "close"
                        ? [kit.button("close", (b) => b.setLabel("Close"))]
                        : [
                              kit.button("back", (b) => b.setLabel("Back").setDisabled(!state.canGoBack)),
                              kit.button("skip", (b) => b.setLabel("Skip")),
                              kit.button("cancel", (b) => b.setLabel("Cancel").setStyle(ButtonStyle.Danger)),
                          ]),
                ),
            ],
            allowedMentions: NO_PINGS,
        }),
        on:
            exit === "close"
                ? { ...sharedHandlers(deps), close: (c) => c.done() }
                : {
                      ...sharedHandlers(deps),
                      back: (c) => c.done({ kind: "back" }),
                      skip: (c) => c.done({ kind: "skip" }),
                      cancel: (c) => c.done({ kind: "cancel" }),
                  },
        // Step mode has none: ez-setup's own flow owns the timeout screen for its whole session.
        onExpire: exit === "close" ? () => EmbedFormatter.info("Menu timed out.") : undefined,
    });
}
