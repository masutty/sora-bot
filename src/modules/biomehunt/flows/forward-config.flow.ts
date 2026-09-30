import type { CommandContext } from "@/define";
import { getDelayedForwardConfigs, removeDelayedForwardConfig, setDelayedForwardConfig } from "../repository/delayed-forwards.repository";
import { getForwardConfigs, removeForwardConfig, setForwardConfig } from "../repository/forwards.repository";
import { settings } from "../settings";
import { type ForwardListDeps, forwardListView } from "../views/forward-list.view";

/** Wires `forwardListView`'s injected deps to the real repository - the only real DB calls in this file. */
const deps: ForwardListDeps = {
    getForwards: getForwardConfigs,
    setForward: setForwardConfig,
    removeForward: async (guildId, biome) => {
        await removeForwardConfig(guildId, biome);
    },
};

/** Same wiring for the "delayed" variant - its create screen always picks a delay, the fallback is never hit. */
const delayedDeps: ForwardListDeps = {
    getForwards: getDelayedForwardConfigs,
    setForward: (guildId, biome, channelId, roleId, delayS) =>
        setDelayedForwardConfig(guildId, biome, channelId, roleId, delayS ?? settings.delayedForward.delayChoicesS[0]),
    removeForward: async (guildId, biome) => {
        await removeDelayedForwardConfig(guildId, biome);
    },
};

/** Standalone entry point for `bh-admin forward menu` / bare `!bh-admin forward`. */
export async function runForwardConfigFlow(ctx: CommandContext, guildId: string): Promise<void> {
    await ctx.open(forwardListView(deps, "close"), { guildId });
}

/** Standalone entry point for `bh-admin delayed-forward menu` / bare `!bh-admin delayed-forward`. */
export async function runDelayedForwardConfigFlow(ctx: CommandContext, guildId: string): Promise<void> {
    await ctx.open(forwardListView(delayedDeps, "close", "delayed"), { guildId });
}
