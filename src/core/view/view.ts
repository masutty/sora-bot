import {
    ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, type Message, type MessageComponentInteraction,
    RoleSelectMenuBuilder, StringSelectMenuBuilder, type User, UserSelectMenuBuilder,
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
 * What a handler receives. A component interaction is answered exactly once by the engine: by the
 * redraw after the handler returns, or by the modal / child view / notify the handler used first.
 */
export interface HandlerContext<S, R> {
    /** Current state - may be mutated in place (Q34). */
    state: S;
    /** Values of the select that fired (ids for channel/role/user selects). Empty for buttons and text. */
    values: string[];
    user: User;
    /** Ends THIS view with `result` once the handler returns; whoever opened it (open/runView) gets the value. */
    done(result: R): void;
    /** Opens a child view on the SAME message; resolves with its result, or `undefined` if it expires. */
    open<CS, CR, CI>(child: ViewDefinition<CS, CR, CI>, input: CI): Promise<CR | undefined>;
    /**
     * Shows a modal (component handlers only, and only as the first answer to the click). Resolves
     * with the values by `key`, or `null` if closed/expired - in which case the message is left
     * untouched unless the handler returns a new state.
     */
    modal(spec: ModalSpec): Promise<Record<string, string> | null>;
    /** Ephemeral answer only for whoever interacted (e.g. "invalid value"), without touching the View's message. */
    notify(content: string): Promise<void>;
    /** Escape hatch: the raw interaction (or typed message) that triggered the handler. */
    raw: MessageComponentInteraction | Message;
}

/** A handler's return: a new state (replaces), or nothing (whatever was mutated stands). */
export type HandlerResult<S> = S | void | Promise<S | void>;

/**
 * A stateful message: `render` turns the state into a message, handlers in `on` change the state,
 * and the engine redraws after each one. Run it with `ctx.open(view, input)` (or `runView`).
 */
export interface ViewDefinition<S, R = void, I = void> {
    /** `<cog>.<name>` - goes into the customId and the logs. */
    name: string;
    initial(input: I): S | Promise<S>;
    /** Pure and fast: state -> message. I/O belongs in `initial` or in the handlers. */
    render(state: S, kit: RenderKit): ViewRender;
    on?: Record<string, (c: HandlerContext<S, R>) => HandlerResult<S>>;
    /** A typed reply, when the current screen has `acceptText`. Return the state; to refuse, `c.notify(...)` and keep it. */
    onText?: (c: HandlerContext<S, R> & { text: string }) => HandlerResult<S>;
    /** Default: config.ui.viewTimeoutMs, idle (renewed by every accepted interaction). */
    timeoutMs?: number;
    /** Default "strip": removes the components, keeps the content. A function = the final payload (e.g. "expired"). */
    onExpire?: "strip" | "disable" | ((state: S) => ViewPayload | Promise<ViewPayload>);
    /** Called on expiry, before the final payload (e.g. reroll auto-applies). The result of open/runView becomes `undefined`. */
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
