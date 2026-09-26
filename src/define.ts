import type { CommandContext, GuildCommandContext } from "./core/command/command-context";
import type { Cog, CommandDefinition, CommandDefinitionBase } from "./types";

// The framework's public surface - modules import from "@/define", never from "@/core/*" directly.
export type { CommandArgs } from "./core/command/command-args";
export type { CommandContext, GuildCommandContext, ReplyOptions, ReplyPayload } from "./core/command/command-context";
export { buildHelpContainer } from "./core/command/command-usage";
export type { PrefixArgs } from "./core/command/prefix-args";
export { UserFacingError } from "./core/command/user-facing-error";
export { type RunViewOptions, runView } from "./core/view/run-view";
export {
    defineView,
    type HandlerContext,
    type HandlerResult,
    type ModalSpec,
    type RenderKit,
    type ViewDefinition,
    type ViewPayload,
    type ViewRender,
} from "./core/view/view";
export type {
    Cog,
    CogAuthor,
    CommandDefinition,
    CommandModes,
} from "./types";

/**
 * Declares a command. Overloaded so `run`'s `ctx` is typed by `guildOnly`: with
 * `guildOnly: true` it's a GuildCommandContext (guild/member non-null), otherwise a CommandContext.
 */
export function defineCommand(def: CommandDefinitionBase & { guildOnly: true; run?: (ctx: GuildCommandContext) => Promise<void> }): CommandDefinition;
export function defineCommand(def: CommandDefinitionBase & { guildOnly?: false; run?: (ctx: CommandContext) => Promise<void> }): CommandDefinition;
export function defineCommand(def: CommandDefinition): CommandDefinition {
    // Sync name/description into the SlashCommandBuilder
    if (def.options) {
        def.options.setName(def.name).setDescription(def.description);
    }

    return { showOnHelp: false, ...def } as CommandDefinition;
}

// the name of the cog should be the same as module/<cog_name>
export function defineCog(cog: Cog): Cog {
    return cog;
}
