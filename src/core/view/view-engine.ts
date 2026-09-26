import { ComponentType, type User } from "discord.js";
import { NO_PINGS } from "@/utils/format";
import { Logger } from "@/utils/logging";
import { getFailureQuip } from "@/utils/quips";
import { config } from "../../config";
import { describeCommandError } from "../command/user-facing-error";
import { createRenderKit, type HandlerContext, type ModalSpec, type ViewDefinition, type ViewPayload, viewCustomId } from "./view";

const logger = new Logger("core.view");

const NOT_YOURS = "This isn't yours!";

// ─── Engine × Transport ─────────────────────────────────────────────────────

/** A click/select on the View's message. `raw` is the transport's interaction (must expose `.user`). */
export type ComponentEvent = { kind: "component"; customId: string; userId: string; values: string[]; raw: unknown };
/** A message typed in the View's channel (bots already filtered out). `raw` must expose `.author`. */
export type TextEvent = { kind: "text"; userId: string; content: string; raw: unknown };

/**
 * The engine's ONLY door to Discord - everything here is I/O, everything in the engine is logic.
 * The engine calls no method before the session's `respond` has resolved, so a transport can be
 * bound to the sent message lazily. Methods returning a promise should not reject on Discord
 * errors they can absorb (a failed notify, a missing Manage Messages): the engine logs rejections
 * but can't do anything better with them.
 */
export interface ViewTransport {
    /** Registers the event receiver (clicks on any id of this message + text in the channel). */
    listen(onEvent: (e: ComponentEvent | TextEvent) => Promise<void>): void;
    /** Turns text listening on/off (only while the current screen asks for it). */
    setTextListening(on: boolean): void;
    /**
     * Answers the click by updating the message (update) - or edits the message if the click was
     * already acknowledged (e.g. it got a `notify`). `e === null`: no interaction to answer, edit
     * the message.
     */
    render(e: ComponentEvent | null, payload: ViewPayload): Promise<void>;
    /** deferUpdate - the answer for a click the engine ignores (stale id, busy view, no handler). */
    acknowledge(e: ComponentEvent): Promise<void>;
    /** Ephemeral / short reply to whoever interacted. May be called on a click that was already answered (then it's a follow-up). */
    notify(e: ComponentEvent | TextEvent, content: string): Promise<void>;
    /**
     * Shows the modal as the answer to `e` and waits up to `timeoutMs` for its submit. The submit
     * comes back as `ack`, still unanswered - the engine answers it with the next render.
     * Closed/timed out → `null`.
     */
    modal(e: ComponentEvent, spec: ModalSpec, customId: string, timeoutMs: number): Promise<{ values: Record<string, string>; ack: ComponentEvent } | null>;
    deleteText(e: TextEvent): Promise<void>;
    /** Ends the listeners (done or expired). */
    close(): void;
}

/** Injectable for tests (a manual clock); the default is the real timers. */
export interface ViewClock {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}

const realClock: ViewClock = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface ViewSession {
    /**
     * Runs `view` as the root of this message: builds its initial state, sends the first render
     * through `respond`, then routes events until it's done (→ its result) or expires
     * (→ `undefined`). Rejects only if the first render can't be built or sent.
     */
    run<S, R, I>(view: ViewDefinition<S, R, I>, input: I, respond: (payload: ViewPayload) => Promise<unknown>): Promise<R | undefined>;
}

// ─── Internals ──────────────────────────────────────────────────────────────

type AnyView = ViewDefinition<unknown, unknown, unknown>;

interface Instance {
    def: AnyView;
    id: string;
    state: unknown;
    /** A handler of this instance is running - further clicks are acknowledged and dropped. */
    busy: boolean;
    resolve(result: unknown): void;
    /** The handler run that opened this child (null for the root). */
    opener: HandlerRun | null;
}

/** One handler invocation and the interaction it still owes an answer to. */
interface HandlerRun {
    event: ComponentEvent | TextEvent;
    /** The interaction the next render answers (the click, or a modal submit); null once spent or for text. */
    ev: ComponentEvent | null;
    /** `ev` got no response at all yet - if nothing renders, it must be acknowledged. */
    needsAck: boolean;
    running: boolean;
    done: { result: unknown } | null;
    /** A cancelled modal: leave the message alone unless the handler returns a new state. */
    skipRedraw: boolean;
}

let instanceCounter = 0;

/** Short: base36 of a global counter + 2 random chars (the random part avoids collisions across restarts). */
function newInstanceId(): string {
    instanceCounter++;
    return instanceCounter.toString(36) + Math.random().toString(36).slice(2, 4).padEnd(2, "0");
}

function logError(err: unknown, meta: object): void {
    logger.error(err instanceof Error ? err : String(err), meta);
}

function withDefaults(payload: ViewPayload): ViewPayload {
    return { ...payload, allowedMentions: payload.allowedMentions ?? NO_PINGS };
}

function eventUser(e: ComponentEvent | TextEvent): User {
    const raw = e.raw as { user?: User; author?: User };
    return (e.kind === "component" ? raw.user : raw.author) as User;
}

function isAllowed(def: AnyView, e: ComponentEvent | TextEvent, invokerId: string): boolean {
    const access = def.access ?? "invoker";
    if (access === "anyone") return true;
    if (access === "invoker") return e.userId === invokerId;
    try {
        return access(eventUser(e));
    } catch (err) {
        logError(err, { view: def.name, phase: "access" });
        return false;
    }
}

type JsonComponent = { type: number; components?: JsonComponent[]; accessory?: JsonComponent; [k: string]: unknown };

function toJsonList(components: ViewPayload["components"]): JsonComponent[] {
    return (components ?? []).map((c) => {
        const encodable = c as { toJSON?: () => JsonComponent };
        return typeof encodable.toJSON === "function" ? encodable.toJSON() : (c as unknown as JsonComponent);
    });
}

/** "strip": drops action rows (at any depth) and turns button-accessory sections into their text. */
function stripInteractive(list: JsonComponent[]): JsonComponent[] {
    return list.flatMap((c) => {
        if (c.type === ComponentType.ActionRow) return [];
        if (c.type === ComponentType.Section && c.accessory?.type === ComponentType.Button) return stripInteractive(c.components ?? []);
        return c.components ? [{ ...c, components: stripInteractive(c.components) }] : [c];
    });
}

/** "disable": keeps every component, with buttons/selects disabled. */
function disableInteractive(list: JsonComponent[]): JsonComponent[] {
    return list.map((c) => {
        if (c.type === ComponentType.ActionRow) return { ...c, components: (c.components ?? []).map((x) => ({ ...x, disabled: true })) };
        const out = { ...c };
        if (c.accessory?.type === ComponentType.Button) out.accessory = { ...c.accessory, disabled: true };
        if (c.components) out.components = disableInteractive(c.components);
        return out;
    });
}

// ─── Session ────────────────────────────────────────────────────────────────

/**
 * The pure View engine for one message. It keeps a stack of instances (root + open children);
 * every event goes to the top one, and a click on another instance's id (a stale parent button)
 * is acknowledged and ignored. The idle timer belongs to the session: every accepted event
 * renews it, and when it fires every instance expires, top to bottom.
 * Each component interaction is answered exactly once: by a render, a modal, a notify or an
 * acknowledge - never two of those.
 */
export function createViewSession(transport: ViewTransport, invokerId: string, clock: ViewClock = realClock): ViewSession {
    const stack: Instance[] = [];
    const cancelModals = new Set<() => void>();
    let started = false;
    let ended = false;
    let timer: unknown = null;
    let textListening = false;
    let modalCounter = 0;

    const top = (): Instance | undefined => stack[stack.length - 1];

    function stopTimer() {
        if (timer !== null) clock.clearTimeout(timer);
        timer = null;
    }

    function armTimer() {
        stopTimer();
        const ms = top()?.def.timeoutMs ?? config.ui.viewTimeoutMs;
        timer = clock.setTimeout(() => void expire(), ms);
    }

    function end() {
        ended = true;
        stopTimer();
        stack.length = 0;
    }

    function renderInstance(inst: Instance): { payload: ViewPayload; acceptText: boolean } {
        const { acceptText, ...payload } = inst.def.render(inst.state, createRenderKit(inst.def.name, inst.id));
        return { payload: withDefaults(payload), acceptText: acceptText ?? false };
    }

    function setText(on: boolean) {
        if (on === textListening) return;
        textListening = on;
        transport.setTextListening(on);
    }

    async function show(inst: Instance, ev: ComponentEvent | null) {
        const { payload, acceptText } = renderInstance(inst);
        await transport.render(ev, payload);
        setText(acceptText);
    }

    async function createInstance(def: AnyView, input: unknown, opener: HandlerRun | null) {
        const state = await def.initial(input);
        let resolve!: (result: unknown) => void;
        const result = new Promise<unknown>((r) => {
            resolve = r;
        });
        const inst: Instance = { def, id: newInstanceId(), state, busy: false, resolve, opener };
        return { inst, result };
    }

    async function expire() {
        if (ended) return;
        const shown = top();
        const all = [...stack].reverse();
        end();
        for (const cancel of cancelModals) cancel();
        for (const inst of all) {
            try {
                await inst.def.beforeExpire?.(inst.state);
            } catch (err) {
                logError(err, { view: inst.def.name, phase: "beforeExpire" });
            }
        }
        try {
            if (shown) await transport.render(null, await expiredPayload(shown));
        } catch (err) {
            logError(err, { view: shown?.def.name, phase: "expire" });
        } finally {
            transport.close();
            for (const inst of all) inst.resolve(undefined);
        }
    }

    async function expiredPayload(inst: Instance): Promise<ViewPayload> {
        const onExpire = inst.def.onExpire ?? "strip";
        if (typeof onExpire === "function") return withDefaults(await onExpire(inst.state));
        const { payload } = renderInstance(inst);
        const list = toJsonList(payload.components);
        const components = onExpire === "strip" ? stripInteractive(list) : disableInteractive(list);
        return { ...payload, components: components as unknown as ViewPayload["components"] };
    }

    /** `done` reached the end of its handler: the root closes the session, a child hands control back. */
    async function finish(inst: Instance, result: unknown, run: HandlerRun) {
        if (!inst.opener) {
            const { payload } = renderInstance(inst); // may throw - the view then stays alive
            const ev = run.ev;
            run.ev = null;
            run.needsAck = false;
            end();
            try {
                await transport.render(ev, payload);
            } finally {
                transport.close();
                inst.resolve(result);
            }
            return;
        }
        stack.pop();
        armTimer();
        const opener = inst.opener;
        if (opener.running) {
            // The opener's handler is still awaiting `open` - its redraw answers this interaction.
            opener.ev = run.ev;
            opener.needsAck = run.needsAck;
            opener.skipRedraw = false;
            run.ev = null;
            run.needsAck = false;
        } else {
            const ev = run.ev;
            run.ev = null;
            run.needsAck = false;
            const parent = top();
            if (parent) await show(parent, ev);
        }
        inst.resolve(result);
    }

    function makeContext(inst: Instance, run: HandlerRun): HandlerContext<unknown, unknown> {
        const name = inst.def.name;
        const e = run.event;
        return {
            get state() {
                return inst.state;
            },
            set state(value) {
                inst.state = value;
            },
            values: e.kind === "component" ? e.values : [],
            user: eventUser(e),
            raw: e.raw as HandlerContext<unknown, unknown>["raw"],

            done(result) {
                if (inst !== top()) throw new Error(`View "${name}": done() called while a child view is open`);
                run.done = { result };
            },

            async open(child, input) {
                if (ended) return undefined;
                const { inst: childInst, result } = await createInstance(child as unknown as AnyView, input, run);
                if (ended) return undefined;
                const { payload, acceptText } = renderInstance(childInst);
                stack.push(childInst);
                armTimer();
                const ev = run.ev;
                run.ev = null;
                run.needsAck = false;
                await transport.render(ev, payload);
                setText(acceptText);
                return result as never;
            },

            async modal(spec) {
                if (ended) return null;
                const clicked = run.ev;
                if (!clicked || !run.needsAck) {
                    throw new Error(`View "${name}": c.modal() must be the first answer to a click (not from onText, nor after notify/open/another modal)`);
                }
                const customId = viewCustomId(name, inst.id, `modal:${++modalCounter}`);
                run.ev = null;
                run.needsAck = false;
                const submitted = await new Promise<{ values: Record<string, string>; ack: ComponentEvent } | null>((resolve) => {
                    let settled = false;
                    const cancel = () => {
                        settled = true;
                        resolve(null);
                    };
                    cancelModals.add(cancel);
                    transport
                        .modal(clicked, spec, customId, config.ui.modalTimeoutMs)
                        .then(
                            (res) => {
                                // Submitted after the View expired: answer it so the user doesn't see "interaction failed".
                                if (settled && res) void transport.acknowledge(res.ack).catch((err) => logError(err, { view: name }));
                                resolve(res);
                            },
                            (err) => {
                                logError(err, { view: name, phase: "modal" });
                                resolve(null);
                            },
                        )
                        .finally(() => cancelModals.delete(cancel));
                });
                if (!submitted) {
                    run.skipRedraw = true;
                    return null;
                }
                run.ev = submitted.ack;
                run.needsAck = true;
                armTimer();
                return submitted.values;
            },

            async notify(content) {
                const target = run.ev ?? e;
                if (target === run.ev) run.needsAck = false;
                await transport.notify(target, content).catch((err) => logError(err, { view: name }));
            },
        };
    }

    async function runHandler(inst: Instance, event: ComponentEvent | TextEvent, key: string, call: (c: HandlerContext<unknown, unknown>) => unknown) {
        const run: HandlerRun = {
            event,
            ev: event.kind === "component" ? event : null,
            needsAck: event.kind === "component",
            running: true,
            done: null,
            skipRedraw: false,
        };
        inst.busy = true;
        try {
            const next = await call(makeContext(inst, run));
            if (next !== undefined) {
                inst.state = next;
                run.skipRedraw = false;
            }
            if (ended || inst !== top()) return;
            if (run.done) {
                await finish(inst, run.done.result, run);
                return;
            }
            if (run.skipRedraw) return;
            const ev = run.ev;
            run.ev = null;
            run.needsAck = false;
            await show(inst, ev);
        } catch (err) {
            logError(err, { view: inst.def.name, key });
            const described = describeCommandError(err);
            const target = run.ev ?? event;
            run.ev = null;
            run.needsAck = false;
            await transport.notify(target, described.kind === "user" ? described.message : getFailureQuip()).catch((e) => logError(e, { view: inst.def.name }));
        } finally {
            run.running = false;
            inst.busy = false;
            if (run.ev && run.needsAck) await transport.acknowledge(run.ev).catch((err) => logError(err, { view: inst.def.name }));
        }
    }

    async function onComponent(e: ComponentEvent) {
        const inst = top();
        const prefix = inst ? `${inst.def.name}:${inst.id}:` : null;
        if (ended || !inst || !prefix || !e.customId.startsWith(prefix)) {
            await transport.acknowledge(e);
            return;
        }
        if (!isAllowed(inst.def, e, invokerId)) {
            await transport.notify(e, NOT_YOURS);
            return;
        }
        armTimer();
        const key = e.customId.slice(prefix.length);
        const handler = inst.def.on?.[key];
        if (inst.busy || !handler) {
            await transport.acknowledge(e);
            return;
        }
        await runHandler(inst, e, key, handler);
    }

    async function onText(e: TextEvent) {
        const inst = top();
        const onTextHandler = inst?.def.onText;
        if (ended || !textListening || !inst || !onTextHandler || inst.busy) return;
        // Someone else's message isn't an answer to this View - ignore it silently.
        if (!isAllowed(inst.def, e, invokerId)) return;
        armTimer();
        if (inst.def.deleteTextInput) await transport.deleteText(e).catch(() => {});
        await runHandler(inst, e, "text", (c) => onTextHandler(Object.assign(c, { text: e.content })));
    }

    async function onEvent(e: ComponentEvent | TextEvent) {
        try {
            if (e.kind === "component") await onComponent(e);
            else await onText(e);
        } catch (err) {
            logError(err, { view: top()?.def.name, phase: "event" });
        }
    }

    return {
        async run<S, R, I>(view: ViewDefinition<S, R, I>, input: I, respond: (payload: ViewPayload) => Promise<unknown>) {
            if (started) throw new Error("A ViewSession runs a single root view");
            started = true;
            const { inst, result } = await createInstance(view as unknown as AnyView, input, null);
            const { payload, acceptText } = renderInstance(inst);
            await respond(payload);
            stack.push(inst);
            transport.listen(onEvent);
            setText(acceptText);
            armTimer();
            return result as Promise<R | undefined>;
        },
    };
}
