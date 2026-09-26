import type { Cog, CommandDefinition } from "./types";


export type { PrefixArgs } from "./core/prefix-args";
export type {
    Cog,
    CogAuthor,
    CommandDefinition,
} from "./types";

const DEFAULT_COMMAND_FLAGS: Partial<CommandDefinition> = {
    showOnHelp: false,
};

export function defineCommand(def: CommandDefinition): CommandDefinition {
    // Sync name/description into the SlashCommandBuilder
    if (def.options) {
        def.options.setName(def.name).setDescription(def.description);
    }

    // Wire execute → executeAsSlash
    if (def.execute && !def.executeAsSlash) {
        def.executeAsSlash = def.execute;
    }

    return { ...DEFAULT_COMMAND_FLAGS, ...def };
}

// the name of the cog should be the same as module/<cog_name>
export function defineCog(cog: Cog): Cog {
    return cog;
}
