import type {
    ChatInputCommandInteraction,
    SlashCommandSubcommandBuilder
} from "discord.js";

export type AdminCommandModule = {
    builder: (
        sub: SlashCommandSubcommandBuilder
    ) => SlashCommandSubcommandBuilder;

    execute: (
        // IMPORTANT NOTE: the interaction is (supposedly) always deferred! dont .reply but .editReply instead
        interaction: ChatInputCommandInteraction
    ) => Promise<void>;
}; 

export type CommandGroup = {
    [name: string]: AdminCommandModule;
};
