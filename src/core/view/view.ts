import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelSelectMenuBuilder,
    type Message,
    type MessageComponentInteraction,
    RoleSelectMenuBuilder,
    StringSelectMenuBuilder,
    type User,
    UserSelectMenuBuilder,
} from "discord.js";
import type { ReplyPayload } from "../command/command-context";

/** What a View shows: the same body `ctx.reply` takes (embeds or ComponentsV2), never a bare string. */
export type ViewPayload = Exclude<ReplyPayload, string>;

export interface ViewRender extends ViewPayload {
    /** While this screen is active, a message from the owner in the View's channel goes to `onText`. */
    acceptText?: boolean;
}

export type AnySelect = StringSelectMenuBuilder | ChannelSelectMenuBuilder | RoleSelectMenuBuilder | UserSelectMenuBuilder;

/**
 * Builds the View's interactive components. Every component is bound to a `key` - the handler in
 * `on[key]` - and gets the customId `<viewName>:<instanceId>:<key>`, so two open copies of the
 * same View never see each other's clicks. Never set a customId by hand: the kit overwrites it.
 */
export interface RenderKit {
    /** Button bound to `key` (handler in `on[key]`). Default style Secondary. */
    button(key: string, configure?: (b: ButtonBuilder) => ButtonBuilder): ButtonBuilder;
    stringSelect(key: string, configure: (s: StringSelectMenuBuilder) => StringSelectMenuBuilder): StringSelectMenuBuilder;
    channelSelect(key: string, configure: (s: ChannelSelectMenuBuilder) => ChannelSelectMenuBuilder): ChannelSelectMenuBuilder;
    roleSelect(key: string, configure: (s: RoleSelectMenuBuilder) => RoleSelectMenuBuilder): RoleSelectMenuBuilder;
    userSelect(key: string, configure: (s: UserSelectMenuBuilder) => UserSelectMenuBuilder): UserSelectMenuBuilder;
    /** Convenience: an ActionRow with the given components. */
    row(...components: (ButtonBuilder | AnySelect)[]): ActionRowBuilder<ButtonBuilder | AnySelect>;
}

export interface ModalSpec {
    title: string;
    fields: Array<{
        key: string;
        label: string;
        style?: "short" | "paragraph";
        required?: boolean;
        value?: string;
        placeholder?: string;
        maxLength?: number;
    }>;
}

/**
 * What a handler (or `start`) receives. A component interaction is answered exactly once by the
 * engine: by the redraw after the handler returns, or by the modal / child view / notify the
 * handler used first.
 */
export interface HandlerContext<S, R> {
    /** Current state - may be mutated in place (Q34). */
    state: S;
    /** Values of the select that fired (ids for channel/role/user selects). Empty for buttons, text and `start`. */
    values: string[];
    /** Who interacted. In `start`: whoever opened the view (the invoker for the root). */
    user: User;
    /**
     * Ends THIS view with `result` once the handler returns; whoever opened it (open/runView) gets
     * the value. A child hands the message back to its opener; the root's final screen is its
     * render with the interactive components stripped (Link buttons are kept - they need no
     * listener and still work).
     */
    done(result: R): void;
    /**
     * Opens a child view on the SAME message; resolves with its result once it's `done`. The
     * child's own `timeoutMs`/`onExpire` don't apply: the session has one idle clock and one
     * expiry screen, both the root's. If the session expires while the child is open, this (and
     * every other pending `open`, and the run itself) resolves `undefined` - check for it.
     */
    open<CS, CR, CI>(child: ViewDefinition<CS, CR, CI>, input: CI): Promise<CR | undefined>;
    /**
     * Shows a modal. Only as the FIRST answer to a button/select click, before any slow work
     * (Discord allows ~3s; after that the engine has already acknowledged the click): not from
     * `start` or `onText`, not after notify/open/another modal, and not in answer to a modal
     * submit - Discord can't show a modal from a modal. So "invalid value → ask again" is: `notify`
     * and let the user click the button again. Misuse throws a clear error.
     * While it's open the View's idle timer is paused. Resolves with the values by `key`, or
     * `null` if closed/expired - in which case the message is left untouched unless the handler
     * returns a new state. Discord never reports a dismissed (Esc) modal: the next accepted click
     * on this view cancels it (it resolves `null`, this handler finishes) and then runs normally.
     */
    modal(spec: ModalSpec): Promise<Record<string, string> | null>;
    /**
     * Ephemeral answer only for whoever interacted (e.g. "invalid value"), without touching the
     * View's message. Best effort: after a modal that was dismissed (the click was already answered
     * by showing the modal) it's a follow-up that may not be seen; in `start` with no interaction
     * to answer (the root's, or a child opened from another `start`) it's a logged no-op.
     */
    notify(content: string): Promise<void>;
    /**
     * Escape hatch: the raw interaction (or typed message) that triggered the handler. In `start`
     * it's the interaction that opened the view; throws if there is none (the root's `start`).
     */
    raw: MessageComponentInteraction | Message;
}

/** A handler's return: a new state (replaces), or nothing (whatever was mutated stands). */
// biome-ignore lint/suspicious/noConfusingVoidType: `void` on purpose - a handler that only mutates the state has no return statement.
export type HandlerResult<S> = S | void | Promise<S | void>;

/**
 * A stateful message: `render` turns the state into a message, handlers in `on` change the state,
 * and the engine redraws after each one. Run it with `ctx.open(view, input)` (or `runView`).
 *
 * Sessions: the view a command opens is the ROOT; `c.open` stacks children on the same message
 * (only the top one receives events). The session has one idle clock and one expiry screen, both
 * owned by the root - a child's `timeoutMs`/`onExpire` are ignored.
 */
export interface ViewDefinition<S, R = void, I = void> {
    /** `<cog>.<name>` - goes into the customId and the logs. */
    name: string;
    initial(input: I): S | Promise<S>;
    /**
     * Runs once when the instance is created (the root at session start, a child when opened),
     * before anything of it is shown - with a handler's lifecycle: the view is busy (clicks on it
     * are dropped) until it returns, then it's rendered, or finished if it called `done`. It may
     * `open` children right away (a flow shows step 1 at once): the first child's render is the
     * view's first screen (for the root, the first message sent - the root's own render never
     * flashes). A root that calls `done` before anything was sent still sends its final render
     * once. There's no interaction behind it: `values` is empty, `modal` throws, `notify` is a
     * no-op unless a child handed a click back. Throwing before anything of it was rendered fails
     * the creation like `initial` would (`open`/`runView` reject).
     */
    start?: (c: HandlerContext<S, R>) => HandlerResult<S>;
    /** Pure and fast: state -> message. I/O belongs in `initial`, `start` or the handlers. */
    render(state: S, kit: RenderKit): ViewRender;
    on?: Record<string, (c: HandlerContext<S, R>) => HandlerResult<S>>;
    /** A typed reply, when the current screen has `acceptText`. Return the state; to refuse, `c.notify(...)` and keep it. */
    onText?: (c: HandlerContext<S, R> & { text: string }) => HandlerResult<S>;
    /**
     * The session's idle timeout - ROOT ONLY (ignored on a child: the root's clock runs while any
     * view is on top). Default config.ui.viewTimeoutMs; renewed by every accepted interaction, paused
     * while a modal is open, and postponed while any instance is running its OWN handler/start code
     * (merely being parked in `c.open`/`c.modal`, waiting on the user, does NOT count and still
     * expires normally). If the idle deadline is reached mid-handler, the session doesn't expire out
     * from under it: once that run settles (with nothing else running), that settling counts as
     * activity too, and the clock is armed fresh for a full `timeoutMs` - so a slow "Apply Now" still
     * gets its own render, and a fresh full window to be idle in before the session actually expires.
     */
    timeoutMs?: number;
    /**
     * The session's final screen on expiry - ROOT ONLY (ignored on a child). Default "strip":
     * removes the interactive components of the screen currently shown (root or child), keeps the
     * content and Link buttons. "disable": keeps them, with buttons/selects disabled (Link buttons
     * untouched). A function gets the ROOT's state and returns the final payload (e.g. "expired").
     */
    onExpire?: "strip" | "disable" | ((state: S) => ViewPayload | Promise<ViewPayload>);
    /**
     * Called on expiry for every open instance (root and children, top to bottom), before the
     * final payload (e.g. reroll auto-applies) - except an instance whose handler (or `start`) is
     * running its own code at that moment (so a slow "apply" isn't applied twice). In practice this
     * skip is now mostly unreachable directly: the engine already postpones expiry entirely while
     * anything is running its own code (see `timeoutMs`), so by the time `beforeExpire` runs, nothing
     * should be - it's kept as defense in depth. An instance merely waiting - on `c.open(child)` or
     * `c.modal(...)` - still gets it (a reroll awaiting a confirm, a flow whose `start` awaits its
     * steps). Every pending `open` and the `open`/`runView` of the root then resolve `undefined` - so
     * a handler resuming from `open` must not apply again.
     */
    beforeExpire?: (state: S) => Promise<void>;
    /** Default "invoker". */
    access?: "invoker" | "anyone" | ((user: User) => boolean);
    /** Deletes the typed message after consuming it (needs Manage Messages; fails silently without). Default false. */
    deleteTextInput?: boolean;
}

/** Identity - exists so `S`/`R`/`I` are inferred once and checked across initial/render/handlers. */
export function defineView<S, R = void, I = void>(def: ViewDefinition<S, R, I>): ViewDefinition<S, R, I> {
    return def;
}

/** Discord rejects a customId over this length - checked here so it fails in dev with a clear message. */
export const MAX_CUSTOM_ID_LENGTH = 100;

/** Builds `<viewName>:<instanceId>:<key>`, throwing (with the view and the key) if Discord would reject it. */
export function viewCustomId(viewName: string, instanceId: string, key: string): string {
    const id = `${viewName}:${instanceId}:${key}`;
    if (id.length > MAX_CUSTOM_ID_LENGTH) {
        throw new Error(
            `View "${viewName}": the customId for key "${key}" is ${id.length} chars (Discord's max is ${MAX_CUSTOM_ID_LENGTH}). Use a shorter key or view name.`,
        );
    }
    return id;
}

/** The kit for one View instance. `configure` runs first, so the kit's customId always wins. */
export function createRenderKit(viewName: string, instanceId: string): RenderKit {
    const id = (key: string) => viewCustomId(viewName, instanceId, key);
    return {
        button(key, configure) {
            const customId = id(key);
            const b = new ButtonBuilder().setStyle(ButtonStyle.Secondary);
            return (configure ? configure(b) : b).setCustomId(customId);
        },
        stringSelect(key, configure) {
            const customId = id(key);
            return configure(new StringSelectMenuBuilder()).setCustomId(customId);
        },
        channelSelect(key, configure) {
            const customId = id(key);
            return configure(new ChannelSelectMenuBuilder()).setCustomId(customId);
        },
        roleSelect(key, configure) {
            const customId = id(key);
            return configure(new RoleSelectMenuBuilder()).setCustomId(customId);
        },
        userSelect(key, configure) {
            const customId = id(key);
            return configure(new UserSelectMenuBuilder()).setCustomId(customId);
        },
        row(...components) {
            return new ActionRowBuilder<ButtonBuilder | AnySelect>().addComponents(...components);
        },
    };
}
