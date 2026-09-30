import type { Message, User } from "discord.js";
import { Logger } from "@/utils/logging";
import { currentTrace, runWithTrace } from "@/utils/trace";
import { createDiscordTransport, type DiscordTransportOptions } from "./discord-transport";
import type { ViewDefinition, ViewPayload } from "./view";
import { type ComponentEvent, createViewSession, type TextEvent, type ViewTransport } from "./view-engine";

const logger = new Logger("core.view.run");

export interface RunViewOptions {
    /** Sends the View's first render and returns the sent message - the one the View then lives on. */
    respond: (payload: ViewPayload) => Promise<Message>;
    /** Who opened the View: its owner for `access: "invoker"` (the default), and `c.user` in the root's `start`. */
    invoker: User;
    /**
     * Edits the sent message when no click token can (an ephemeral message rejects `message.edit`,
     * e.g. an expiry before the first click, or a redraw after a first-click `notify`).
     */
    editMessage?: DiscordTransportOptions["editMessage"];
    /** Test seam: builds the transport for the sent message. Default: the discord.js transport. */
    transportFactory?: (message: Message, options: DiscordTransportOptions) => ViewTransport;
}

/**
 * Runs `view` on a new message: sends its first render through `respond`, then handles its
 * interactions until it's done (→ its result) or expires (→ `undefined`). Rejects only if the
 * root can't be created (its initial/start throw before anything was sent) or the first render
 * can't be built or sent. Inside a command, prefer `ctx.open(view, input)`.
 */
export function runView<S, R, I>(view: ViewDefinition<S, R, I>, input: I, opts: RunViewOptions): Promise<R | undefined> {
    // The View outlives the command that opened it, and its clicks arrive from the gateway, outside
    // any async context. Capture the opener's trace now and re-enter it for every event, as a
    // numbered step - so a click's log lines still say which invocation (and user/guild) they belong to.
    const trace = currentTrace();
    let step = 0;
    const traced = (onEvent: (e: ComponentEvent | TextEvent) => Promise<void>) => (e: ComponentEvent | TextEvent) => {
        const handle = () => {
            // Every interaction is logged (who did what), so a user's path through a View is traceable.
            logger.info(describeViewEvent(e, opts.invoker.id));
            return onEvent(e);
        };
        if (!trace) return handle();
        return runWithTrace({ ...trace, step: `${++step}:${viewEventKey(e)}` }, handle);
    };
    logger.debug(`view ${view.name} opened`);

    const factory = opts.transportFactory ?? createDiscordTransport;
    // The engine calls no transport method before `respond` resolves, so the transport is bound
    // to the sent message then, and this forwarder only has to exist before that.
    let bound: ViewTransport | null = null;
    const transport = (): ViewTransport => {
        if (!bound) throw new Error(`View ${view.name}: transport used before the first render was sent`);
        return bound;
    };
    const forward: ViewTransport = {
        listen: (onEvent: (e: ComponentEvent | TextEvent) => Promise<void>) => transport().listen(traced(onEvent)),
        setTextListening: (on) => transport().setTextListening(on),
        render: (e, payload) => transport().render(e, payload),
        acknowledge: (e) => transport().acknowledge(e),
        notify: (e, content) => transport().notify(e, content),
        modal: (e, spec, customId, timeoutMs, signal) => transport().modal(e, spec, customId, timeoutMs, signal),
        deleteText: (e) => transport().deleteText(e),
        close: () => transport().close(),
    };
    const session = createViewSession(forward, opts.invoker);
    return session.run(view, input, async (payload) => {
        const message = await opts.respond(payload);
        bound = factory(message, { editMessage: opts.editMessage });
    });
}

/** The View key an event targets - customIds are `<view>:<instance>:<key>`, and a key may itself contain ":" (e.g. `tab:sessions`). */
export function viewEventKey(e: ComponentEvent | TextEvent): string {
    return e.kind === "text" ? "text" : e.customId.split(":").slice(2).join(":");
}

const MAX_LOGGED_TEXT = 80;

/** One log line per interaction: `click back`, `select pick = [a, b]`, `text "3"` - plus who, when it isn't the invoker. */
export function describeViewEvent(e: ComponentEvent | TextEvent, invokerId: string): string {
    let what: string;
    if (e.kind === "text") {
        const text = e.content.length > MAX_LOGGED_TEXT ? `${e.content.slice(0, MAX_LOGGED_TEXT)}…` : e.content;
        what = `text "${text}"`;
    } else {
        what = e.values.length ? `select ${viewEventKey(e)} = [${e.values.join(", ")}]` : `click ${viewEventKey(e)}`;
    }
    return e.userId === invokerId ? what : `${what} (by ${e.userId} - not the invoker)`;
}
