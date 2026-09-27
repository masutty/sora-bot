import type { Guild, Message, User } from "discord.js";
import { type CommandContext, runView } from "@/define";
import { getForwardConfigs, removeForwardConfig, setForwardConfig } from "../repository/forwards.repository";
import { type ForwardListDeps, forwardListView } from "../views/forward-list.view";

/** What the outer step driver (`ez-setup.flow.ts`) should do next - unchanged from before this port. */
type Direction = "forward" | "back" | "cancel" | "timeout";

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

/**
 * ezsetup wizard step - the same `biomehunt.forward-list` in "step" mode, translated back to the
 * old `(guild, adminId, msg, canGoBack) => Direction` shape `ez-setup.flow.ts` still expects.
 *
 * TODO(task-8): remove once ez-setup.flow.ts is ported to the `flow()` primitive - at that point
 * this step is just `forwardListView(deps, "step")` opened directly by `flow()`, like any other step.
 */
export async function stepBiomeForwards(guild: Guild, adminId: string, msg: Message, canGoBack: boolean): Promise<Direction> {
    const result = await runView(forwardListView(deps, "step"), { guildId: guild.id, canGoBack }, {
        respond: async (payload) => {
            await msg.edit(payload);
            return msg;
        },
        invoker: { id: adminId } as User,
    });

    if (result === undefined) return "timeout";
    if (result.kind === "skip") return "forward";
    if (result.kind === "back") return "back";
    return "cancel";
}
