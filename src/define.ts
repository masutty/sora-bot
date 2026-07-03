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

export function defineCommand(options: CommandDefinition): CommandDefinition {
	return options;
}

export function defineModule(options: ModuleDefinition): ModuleDefinition {
	return options;
}
