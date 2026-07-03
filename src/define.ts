import type { CommandDefinition, ModuleDefinition } from "./types";

export type {
    ArgHelper,
    ArgType,
    CommandArg,
    CommandContext,
    ReplyPayload,
    SentMessage,
} from "./core/context";

export type {
    CommandDefinition,
    ModuleAuthor,
    ModuleDefinition,
} from "./types";

const DEFAULT_COMMAND_FLAGS: Partial<CommandDefinition> = {
    hidden: false,
    prefixEnabled: true,
};

export function defineCommand(options: CommandDefinition): CommandDefinition {
    if (options.options) {
        options.options
            .setName(options.name)
            .setDescription(options.description);
    }
    return { ...DEFAULT_COMMAND_FLAGS, ...options };
}

const DEFAULT_MODULE_FLAGS: Partial<ModuleDefinition> = {
    
}

export function defineModule(options: ModuleDefinition): ModuleDefinition {
    return options;
}
