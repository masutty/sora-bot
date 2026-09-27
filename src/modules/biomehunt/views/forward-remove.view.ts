import { ContainerBuilder, MessageFlags } from "discord.js";
import { defineView, paginationHandlers, paginationRow, type ViewDefinition, type ViewRender } from "@/define";
import { NO_PINGS } from "@/utils/format";
import type { BiomeForwardRow } from "../types";
import { formatForwardLine } from "./forward-list.view";

const FORWARDS_PER_PAGE = 10;

export interface ForwardRemoveInput {
    forwards: BiomeForwardRow[];
}

interface ForwardRemoveState {
    forwards: BiomeForwardRow[];
    page: number;
}

function pages(forwards: BiomeForwardRow[]): number {
    return Math.max(Math.ceil(forwards.length / FORWARDS_PER_PAGE), 1);
}

/**
 * Numbered removal list (10/page, numbering global across pages) - `biomehunt.forward-remove`, a
 * child of `biomehunt.forward-list`'s "Remove". Types the number to remove (`acceptText`/`onText`,
 * retrying on an invalid one via `c.notify`), racing that against its own Back and the shared
 * pagination row. Resolves the picked forward, or `undefined` on Back.
 */
export function forwardRemoveView(): ViewDefinition<ForwardRemoveState, BiomeForwardRow | undefined, ForwardRemoveInput> {
    return defineView<ForwardRemoveState, BiomeForwardRow | undefined, ForwardRemoveInput>({
        name: "biomehunt.forward-remove",
        initial: (input) => ({ forwards: input.forwards, page: 0 }),
        render: (state, kit): ViewRender => {
            const pageCount = pages(state.forwards);
            const start = state.page * FORWARDS_PER_PAGE;
            const slice = state.forwards.slice(start, start + FORWARDS_PER_PAGE);
            const lines = slice.map((f, i) => `${start + i + 1}. ${formatForwardLine(f)}`);

            const container = new ContainerBuilder().setAccentColor(0x5865f2);
            container.addTextDisplayComponents((td) =>
                td.setContent(`**Remove Forward**\nType the number of the forward you want to remove:\n\n${lines.join("\n")}`),
            );
            container.addSeparatorComponents((sep) => sep.setDivider(true));
            container.addTextDisplayComponents((td) => td.setContent(`-# Page ${state.page + 1} of ${pageCount}`));

            return {
                flags: MessageFlags.IsComponentsV2,
                acceptText: true,
                components: [
                    container,
                    kit.row(kit.button("back", (b) => b.setLabel("Back"))),
                    ...(pageCount > 1 ? [paginationRow(kit, state.page, pageCount)] : []),
                ],
                allowedMentions: NO_PINGS,
            };
        },
        on: {
            back: (c) => c.done(undefined),
            ...paginationHandlers<ForwardRemoveState, BiomeForwardRow | undefined>({ pages: (s) => pages(s.forwards) }),
        },
        onText: async (c) => {
            const n = Number(c.text.trim());
            if (!Number.isInteger(n) || n < 1 || n > c.state.forwards.length) {
                await c.notify(`Please type a number between 1 and ${c.state.forwards.length}.`);
                return;
            }
            c.done(c.state.forwards[n - 1]);
        },
    });
}
