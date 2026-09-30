import type { CommandContext } from "@/define";
import { getForwardConfigs, removeForwardConfig, setForwardConfig } from "../repository/forwards.repository";
import { type ForwardListDeps, forwardListView } from "../views/forward-list.view";

/** Wires `forwardListView`'s injected deps to the real repository - the only real DB calls in this file. */
const deps: ForwardListDeps = {
    getForwards: getForwardConfigs,
    setForward: setForwardConfig,
    removeForward: async (guildId, biome) => {
        await removeForwardConfig(guildId, biome);
    },
};

/** Standalone entry point for `bh-admin forward menu` / bare `!bh-admin forward`. */
export async function runForwardConfigFlow(ctx: CommandContext, guildId: string): Promise<void> {
    await ctx.open(forwardListView(deps, "close"), { guildId });
}
