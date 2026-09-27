import {
    type BaseMessageOptions, type ChatInputCommandInteraction, type Guild, type GuildMember, type Message,
    MessageFlags, type User,
} from "discord.js";
import { config } from "../../config";
import type { BotClient } from "../bot-client";
import { type RunViewOptions, runView } from "../view/run-view";
import type { ViewDefinition } from "../view/view";
import { type CommandArgs, prefixArgs, slashArgs } from "./command-args";
import type { PrefixArgs } from "./prefix-args";

export type CommandMode = "slash" | "prefix";

/** A plain string (sent as `content`) or a message body. Both embeds and ComponentsV2 work in both modes. */
export type ReplyPayload = string | (BaseMessageOptions & { flags?: MessageFlags.IsComponentsV2 });

export interface ReplyOptions {
    /**
     * Slash: a real ephemeral message. Prefix: there's no such thing, so the reply is sent publicly
     * and deleted after `ttlMs` (default `config.ui.prefixEphemeralTtlMs`).
     */
    ephemeral?: boolean;
    /**
     * Prefix only: how long an ephemeral reply lives. For `reply` the countdown starts at SEND time
     * and does not reset on button clicks. For `open` it starts when the View's session ENDS (done
     * or expired - counted from its final render), so an open View is never deleted under the user.
     */
    ttlMs?: number;
}

/** Framework-provided pieces a context can't compute by itself (the command's usage needs its definition). */
export interface ContextDeps {
    schedule?: (fn: () => void, ms: number) => void;
    usage?: () => ReplyPayload | null;
    /** Called once, right after the first reply is sent - the command log's "replied in". */
    onFirstReply?: () => void;
    /** Test seam: the transport `open` runs its View on. Default: the discord.js transport. */
    viewTransport?: RunViewOptions["transportFactory"];
}

/**
 * Everything a command's `run(ctx)` needs, the same in slash and prefix. Replying is stateful and
 * handled here - prefer ctx.reply over interaction.reply/editReply/followUp:
 * - 1st `reply()` -> the command's response (after `defer()`, it fills the deferred one).
 * - Later `reply()`s -> follow-ups. `editReply()` edits the first response.
 * The slash state is read from the interaction itself, so a `reply`/`followUp` made through
 * `ctx.raw` (e.g. a modal flow) doesn't desync it. Exception: after `ctx.defer()`, don't fill the
 * deferred response with `ctx.raw.interaction.editReply` - the next `ctx.reply` would edit it again
 * instead of following up. Use `ctx.reply` for that first response.
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
    /** Slash: deferReply. Prefix: typing indicator. `ephemeral` here becomes the default for every later reply. */
    defer(opts?: ReplyOptions): Promise<void>;
    reply(payload: ReplyPayload, opts?: ReplyOptions): Promise<Message>;
    /** Edits the first response. Call it only after a `reply()`. */
    editReply(payload: ReplyPayload): Promise<Message>;
    /** Replies with this command's auto-generated usage (the same one prefix shows for a missing subcommand). */
    replyUsage(): Promise<Message | null>;
    /**
     * Runs `view` as a new reply: `opts` apply to that first message (prefix `ephemeral` deletes
     * it `ttlMs` after the View's session ends). Resolves with the View's `done` result, or
     * `undefined` if it expires. The invoker is its owner.
     */
    open<S, R, I>(view: ViewDefinition<S, R, I>, input: I, opts?: ReplyOptions): Promise<R | undefined>;
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

export function createSlashContext(interaction: ChatInputCommandInteraction, client: BotClient, deps: ContextDeps = {}): CommandContext {
    // editReply doesn't flip interaction.replied, so "the deferred response was already filled" needs its own flag.
    let filledDeferred = false;
    let defaultEphemeral = false;

    const ctx: CommandContext = {
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
            if (interaction.deferred || interaction.replied) return;
            defaultEphemeral = opts?.ephemeral ?? false;
            await interaction.deferReply(defaultEphemeral ? { flags: MessageFlags.Ephemeral } : {});
        },

        async reply(payload, opts) {
            const ephemeral = opts?.ephemeral ?? defaultEphemeral;
            const body = toBody(payload);
            if (interaction.deferred && !interaction.replied && !filledDeferred) {
                // A deferred response's ephemerality was fixed by defer() - editReply can't change it.
                filledDeferred = true;
                return interaction.editReply(body as never);
            }
            if (!interaction.deferred && !interaction.replied) {
                await interaction.reply(withEphemeral(body, ephemeral) as never);
                return interaction.fetchReply();
            }
            return interaction.followUp(withEphemeral(body, ephemeral) as never);
        },

        async editReply(payload) {
            return interaction.editReply(toBody(payload) as never);
        },

        async replyUsage() {
            const usage = deps.usage?.();
            return usage ? ctx.reply(usage) : null;
        },

        open(view, input, opts) {
            return runView(view, input, {
                respond: (p) => ctx.reply(p, opts),
                invoker: ctx.user,
                // An ephemeral View can only be edited through the command's token until a click brings a newer one.
                editMessage: (message, payload) => interaction.webhook.editMessage(message, payload as never),
                transportFactory: deps.viewTransport,
            });
        },
    };
    return withFirstReplyHook(ctx, deps.onFirstReply);
}

export function createPrefixContext(
    message: Message,
    args: PrefixArgs,
    client: BotClient,
    prefix: string,
    deps: ContextDeps = {},
): CommandContext {
    // unref'd: a pending delete never keeps the process alive. Consequence: a restart (e.g. a
    // deploy) inside the TTL leaves that message undeleted.
    const schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms).unref?.());
    let defaultEphemeral = false;
    let first: Message | null = null;
    const scheduleDelete = (sent: Message, opts: ReplyOptions | undefined) =>
        schedule(() => void sent.delete().catch(() => {}), opts?.ttlMs ?? config.ui.prefixEphemeralTtlMs);

    const ctx: CommandContext = {
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
            const channel = message.channel as { sendTyping?: () => Promise<unknown> };
            await channel.sendTyping?.().catch(() => {});
        },

        async reply(payload, opts) {
            const sent = await message.reply(toBody(payload) as never);
            first ??= sent;
            if (opts?.ephemeral ?? defaultEphemeral) scheduleDelete(sent, opts);
            return sent;
        },

        async editReply(payload) {
            if (!first) throw new Error("editReply() called before any reply()");
            return first.edit(toBody(payload) as never);
        },

        async replyUsage() {
            const usage = deps.usage?.();
            return usage ? ctx.reply(usage) : null;
        },

        open(view, input, opts) {
            // "Ephemeral" here is a delete after the TTL: for a View it's scheduled once the session
            // ends, not at the first send - the View may still be in use when a send-time TTL fires.
            const ephemeral = opts?.ephemeral ?? defaultEphemeral;
            let sent: Message | null = null;
            const run = runView(view, input, {
                respond: async (p) => {
                    sent = await ctx.reply(p, { ...opts, ephemeral: false });
                    return sent;
                },
                invoker: ctx.user,
                transportFactory: deps.viewTransport,
            });
            if (!ephemeral) return run;
            return run.finally(() => {
                if (sent) scheduleDelete(sent, opts);
            });
        },
    };
    return withFirstReplyHook(ctx, deps.onFirstReply);
}

/** Wraps `ctx.reply` so `hook` fires once, after the first reply is actually sent. */
function withFirstReplyHook(ctx: CommandContext, hook: (() => void) | undefined): CommandContext {
    if (!hook) return ctx;
    const send = ctx.reply;
    let fired = false;
    ctx.reply = async (payload, opts) => {
        const sent = await send(payload, opts);
        if (!fired) {
            fired = true;
            hook();
        }
        return sent;
    };
    return ctx;
}
