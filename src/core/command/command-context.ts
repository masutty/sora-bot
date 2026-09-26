import {
    type BaseMessageOptions, type ChatInputCommandInteraction, type Guild, type GuildMember, type Message,
    MessageFlags, type User,
} from "discord.js";
import { config } from "../../config";
import type { BotClient } from "../bot-client";
import { type CommandArgs, prefixArgs, slashArgs } from "./command-args";
import type { PrefixArgs } from "./prefix-args";

export type CommandMode = "slash" | "prefix";

/** A plain string (sent as `content`) or a message body. Both embeds and ComponentsV2 work in both modes. */
export type ReplyPayload = string | (BaseMessageOptions & { flags?: MessageFlags.IsComponentsV2 });

export interface ReplyOptions {
    /**
     * Slash: a real ephemeral message. Prefix: there's no such thing, so the reply is sent publicly
     * and deleted after `config.ui.prefixEphemeralTtlMs` - keep that >= any button timeout left on it.
     */
    ephemeral?: boolean;
}

/**
 * Everything a command's `run(ctx)` needs, the same in slash and prefix. Replying is stateful and
 * handled here - never call interaction.reply/editReply/followUp yourself from `run`:
 * - 1st `reply()` -> the command's response (after `defer()`, it fills the deferred one).
 * - Later `reply()`s -> follow-ups. `editReply()` edits the first response.
 * `raw` is the typed escape hatch for the rare mode-specific need (e.g. reading a prefix message's
 * attachment); prefer declaring `modes`/`subcommandModes` over branching on it.
 */
export interface CommandContext {
    readonly mode: CommandMode;
    readonly client: BotClient;
    readonly user: User;
    readonly guild: Guild | null;
    readonly member: GuildMember | null;
    readonly args: CommandArgs;
    /** "/" for slash, the guild's prefix for prefix - for building "try `<prefix>cmd ...`" hints. */
    readonly invokePrefix: string;
    /** When the invocation was created (for latency math like `ping`). */
    readonly createdTimestamp: number;
    readonly raw:
        | { kind: "slash"; interaction: ChatInputCommandInteraction }
        | { kind: "prefix"; message: Message; args: PrefixArgs };
    /** Slash: deferReply. Prefix: no-op. `ephemeral` here becomes the default for every later reply. */
    defer(opts?: ReplyOptions): Promise<void>;
    reply(payload: ReplyPayload, opts?: ReplyOptions): Promise<Message>;
    /** Edits the first response. Call it only after a `reply()`. */
    editReply(payload: ReplyPayload): Promise<Message>;
}

/** What `run` receives for a `guildOnly: true` command - guild and member are guaranteed. */
export interface GuildCommandContext extends CommandContext {
    readonly guild: Guild;
    readonly member: GuildMember;
}

function toBody(payload: ReplyPayload): BaseMessageOptions & { flags?: number } {
    return typeof payload === "string" ? { content: payload } : payload;
}

function withEphemeral(body: BaseMessageOptions & { flags?: number }, ephemeral: boolean) {
    if (!ephemeral) return body;
    return { ...body, flags: (body.flags ?? 0) | MessageFlags.Ephemeral };
}

export function createSlashContext(interaction: ChatInputCommandInteraction, client: BotClient): CommandContext {
    let deferred = false;
    let responded = false;
    let defaultEphemeral = false;

    return {
        mode: "slash",
        client,
        user: interaction.user,
        guild: interaction.guild,
        member: (interaction.member as GuildMember | null) ?? null,
        args: slashArgs(interaction),
        invokePrefix: "/",
        createdTimestamp: interaction.createdTimestamp,
        raw: { kind: "slash", interaction },

        async defer(opts) {
            if (deferred || responded) return;
            defaultEphemeral = opts?.ephemeral ?? false;
            await interaction.deferReply(defaultEphemeral ? { flags: MessageFlags.Ephemeral } : {});
            deferred = true;
        },

        async reply(payload, opts) {
            const ephemeral = opts?.ephemeral ?? defaultEphemeral;
            const body = toBody(payload);
            if (!responded && deferred) {
                // A deferred response's ephemerality was fixed by defer() - editReply can't change it.
                responded = true;
                return interaction.editReply(body as never);
            }
            if (!responded) {
                responded = true;
                await interaction.reply(withEphemeral(body, ephemeral) as never);
                return interaction.fetchReply();
            }
            return interaction.followUp(withEphemeral(body, ephemeral) as never);
        },

        async editReply(payload) {
            return interaction.editReply(toBody(payload) as never);
        },
    };
}

export function createPrefixContext(
    message: Message,
    args: PrefixArgs,
    client: BotClient,
    prefix: string,
    deps: { schedule?: (fn: () => void, ms: number) => void } = {},
): CommandContext {
    const schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms).unref?.());
    let defaultEphemeral = false;
    let first: Message | null = null;

    return {
        mode: "prefix",
        client,
        user: message.author,
        guild: message.guild,
        member: message.member,
        args: prefixArgs(args),
        invokePrefix: prefix,
        createdTimestamp: message.createdTimestamp,
        raw: { kind: "prefix", message, args },

        async defer(opts) {
            defaultEphemeral = opts?.ephemeral ?? defaultEphemeral;
        },

        async reply(payload, opts) {
            const sent = await message.reply(toBody(payload) as never);
            first ??= sent;
            if (opts?.ephemeral ?? defaultEphemeral) {
                schedule(() => void sent.delete().catch(() => {}), config.ui.prefixEphemeralTtlMs);
            }
            return sent;
        },

        async editReply(payload) {
            if (!first) throw new Error("editReply() called before any reply()");
            return first.edit(toBody(payload) as never);
        },
    };
}
