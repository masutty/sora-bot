import { ButtonStyle, ComponentType, type User } from "discord.js";
import { NO_PINGS } from "@/utils/format";
import { Logger } from "@/utils/logging";
import { getFailureQuip } from "@/utils/quips";
import { config } from "../../config";
import { describeCommandError } from "../command/user-facing-error";
import { createRenderKit, type HandlerContext, type ModalSpec, type ViewDefinition, type ViewPayload, viewCustomId } from "./view";

const logger = new Logger("core.view");

const NOT_YOURS = "This isn't yours!";

/**
 * Discord drops an interaction that gets no response within 3s ("interaction failed", and the late
 * update is rejected). If a handler is still working this long after the click (slow I/O, or a
 * parent doing work after `await c.open`), the engine acknowledges the click (deferUpdate) and the
 * handler's redraw then goes through the "already acknowledged → edit" path of `render`.
 * 2.5s leaves headroom for the round-trip.
 */
export const ACK_DEADLINE_MS = 2_500;

/**
 * While a modal is open the idle timer is paused: the user is typing, the session is active. The
 * timer is still armed for the modal's own timeout plus this margin, as a safety net for a
 * transport that never settles the modal - the View then expires and the modal resolves `null`.
 */
export const MODAL_EXPIRY_GRACE_MS = 5_000;

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
     * Closed/timed out, `signal` aborted, or the transport closed → `null` (a submit that still
     * arrives after that is the transport's to acknowledge). Rejects if `e` can't show a modal
     * (already answered, or a modal submit) - after answering it, so the click never fails.
     */
    modal(
        e: ComponentEvent,
        spec: ModalSpec,
        customId: string,
        timeoutMs: number,
        signal?: AbortSignal,
    ): Promise<{ values: Record<string, string>; ack: ComponentEvent } | null>;
    deleteText(e: TextEvent): Promise<void>;
    /** Ends the listeners (done or expired), and resolves every pending `modal` wait with `null`. */
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

/** Why a View session ended - logged when it closes. */
export enum ViewCloseReason {
    /** The root called `done`. */
    Done = "done",
    /** The idle timeout ran out. */
    Expired = "expired",
    /** The root couldn't be created or its first message couldn't be sent. */
    Failed = "failed",
}

export interface ViewSession {
    /**
     * Runs `view` as the root of this message: builds its initial state, runs its `start`, sends
     * the first render through `respond`, then routes events until it's done (→ its result) or
     * expires (→ `undefined`). Rejects only if the root can't be created (initial/start throw
     * before anything was sent) or the first render can't be built or sent.
     */
    run<S, R, I>(view: ViewDefinition<S, R, I>, input: I, respond: (payload: ViewPayload) => Promise<unknown>): Promise<R | undefined>;
}

// ─── Internals ──────────────────────────────────────────────────────────────

type AnyView = ViewDefinition<unknown, unknown, unknown>;

interface Instance {
    def: AnyView;
    id: string;
    state: unknown;
    /** A handler (or `start`) of this instance is running - further clicks are acknowledged and dropped. */
    busy: boolean;
    /** The run that holds `busy`. */
    run: HandlerRun | null;
    resolve(result: unknown): void;
    /** The handler run that opened this child (null for the root). */
    opener: HandlerRun | null;
}

/**
 * A component interaction the engine must answer exactly once. Shared by reference when a child
 * hands its click over to the opener, so the ACK_DEADLINE_MS watchdog follows the interaction.
 */
interface Pending {
    e: ComponentEvent;
    /** Got a response (render, notify, showModal or the watchdog's acknowledge). A later render then edits. */
    answered: boolean;
    /** A modal submit: Discord can't answer it with another modal. */
    fromModalSubmit: boolean;
    watchdog: unknown;
}

/** The part of a `start` run that decides when `open`/`runView` can go on. */
interface StartPhase {
    /** Settled: something of the instance is on screen (its render, or a child's), or it ended without showing anything. */
    ready: boolean;
    /** `shown`: false when it ended (e.g. `done` at once) without anything of it being painted. */
    resolve(shown: boolean): void;
    reject(err: unknown): void;
}

/** One handler (or `start`) invocation and the interaction its next render goes through. */
interface HandlerRun {
    /** What triggered it. For `start`: the opener's event, or null (the root, or opened from another `start`). */
    event: ComponentEvent | TextEvent | null;
    user: User;
    /** Set for a `start` run. */
    start: StartPhase | null;
    /** The click, a modal submit or a child's click handed over; null once rendered/shown a modal, and for text. */
    pending: Pending | null;
    running: boolean;
    done: { result: unknown } | null;
    /** A cancelled modal: leave the message alone unless the handler returns a new state. */
    skipRedraw: boolean;
    /** Set while the handler is parked in `c.modal()`: cancels that modal (it resolves `null`). */
    cancelModal: (() => void) | null;
    /**
     * How many `open`/`modal` waits the handler is parked in. A parked handler is waiting on the
     * user, not doing its own work - expiry still runs its instance's `beforeExpire`.
     */
    parked: number;
    /** Resolves once the run ended and settled its interaction. */
    finished: Promise<void>;
    markFinished(): void;
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

/** A Link button opens a URL: no customId, no listener - it keeps working after the View closes. */
const isLink = (c: JsonComponent | undefined) => c?.type === ComponentType.Button && c.style === ButtonStyle.Link;

/** "strip": drops action rows (at any depth) and turns button-accessory sections into their text - Link buttons stay. */
function stripInteractive(list: JsonComponent[]): JsonComponent[] {
    return list.flatMap((c) => {
        if (c.type === ComponentType.ActionRow) {
            const links = (c.components ?? []).filter(isLink);
            return links.length > 0 ? [{ ...c, components: links }] : [];
        }
        if (c.type === ComponentType.Section && c.accessory?.type === ComponentType.Button && !isLink(c.accessory)) {
            return stripInteractive(c.components ?? []);
        }
        return c.components ? [{ ...c, components: stripInteractive(c.components) }] : [c];
    });
}

/** "disable": keeps every component, with buttons/selects disabled (Link buttons untouched). */
function disableInteractive(list: JsonComponent[]): JsonComponent[] {
    const disable = (x: JsonComponent) => (isLink(x) ? x : { ...x, disabled: true });
    return list.map((c) => {
        if (c.type === ComponentType.ActionRow) return { ...c, components: (c.components ?? []).map(disable) };
        const out = { ...c };
        if (c.accessory?.type === ComponentType.Button) out.accessory = disable(c.accessory);
        if (c.components) out.components = disableInteractive(c.components);
        return out;
    });
}

// ─── Session ────────────────────────────────────────────────────────────────

/**
 * The pure View engine for one message. It keeps a stack of instances (root + open children);
 * every event goes to the top one, and a click on another instance's id (a stale parent button)
 * is acknowledged and ignored. The idle timer belongs to the session and its duration and expiry
 * screen to the root: every accepted event renews it, and when it fires the whole session expires -
 * UNLESS some instance is at that moment running its OWN handler/start code (not merely parked in
 * `c.open`/`c.modal`, waiting on the user): then expiry is postponed, and once that run settles
 * (with nothing else running), the clock is armed fresh for a full `timeoutMs` - the run itself
 * counts as activity, so a slow handler is never expired out from under its own in-flight redraw.
 * Each component interaction is answered exactly once: by a render, a modal, a notify or an
 * acknowledge - never two of those.
 */
export function createViewSession(transport: ViewTransport, invoker: User, clock: ViewClock = realClock): ViewSession {
    const stack: Instance[] = [];
    let openedAt = 0;
    const cancelModals = new Set<() => void>();
    let respond: ((payload: ViewPayload) => Promise<unknown>) | null = null;
    /** The first render went out through `respond` (then the transport is usable). */
    let sent = false;
    let listening = false;
    let firstSendError: { err: unknown } | null = null;
    let ended = false;
    let timer: unknown = null;
    let textListening = false;
    let modalCounter = 0;
    let pendingModals = 0;
    /** The instance whose screen is on the message - can lag behind `top()` right after a child pops. */
    let onScreen: Instance | null = null;
    /** The idle timer fired while something was running its own code - `armTimer` owes it a fresh timeout once that settles. */
    let expirePostponed = false;

    const top = (): Instance | undefined => stack[stack.length - 1];

    /** True while `inst`'s OWN handler/start is executing - as opposed to merely parked in `c.open`/`c.modal`, waiting on the user (which doesn't count). */
    function isRunningOwnCode(inst: Instance): boolean {
        return inst.busy && !(inst.run && inst.run.parked > 0);
    }

    /** Whether ANY instance on the stack is currently running its own code - if so, the session can't expire right now. */
    function anyRunningOwnCode(): boolean {
        return stack.some(isRunningOwnCode);
    }

    function stopTimer() {
        if (timer !== null) clock.clearTimeout(timer);
        timer = null;
    }

    /** The session's idle clock: its duration is the ROOT's, whoever is on top. Starts once the first render is sent. */
    function armTimer() {
        if (!sent || ended) return;
        stopTimer();
        expirePostponed = false; // a fresh timer supersedes any earlier postponement.
        const viewMs = stack[0]?.def.timeoutMs ?? config.ui.viewTimeoutMs;
        // A modal being filled in is activity: only the MODAL_EXPIRY_GRACE_MS safety net runs meanwhile.
        const ms = pendingModals > 0 ? Math.max(viewMs, config.ui.modalTimeoutMs + MODAL_EXPIRY_GRACE_MS) : viewMs;
        timer = clock.setTimeout(() => {
            if (anyRunningOwnCode()) {
                // Don't expire out from under a running handler - `settleRun`'s caller re-arms once it's done.
                expirePostponed = true;
                return;
            }
            void expire();
        }, ms);
    }

    /** Called once a handler/start run has fully finished (busy released). If the idle timer fired
     * while it (or something else) was running, and nothing is running anymore, that settling
     * counts as activity: arm a fresh full timeout instead of expiring immediately. */
    function armAfterSettle() {
        if (expirePostponed && !anyRunningOwnCode()) armTimer();
    }

    /** Starts owing `e` an answer; if the handler is still busy at ACK_DEADLINE_MS, acknowledges it. */
    function track(e: ComponentEvent, fromModalSubmit = false): Pending {
        const p: Pending = { e, answered: false, fromModalSubmit, watchdog: null };
        p.watchdog = clock.setTimeout(() => {
            if (p.answered) return;
            p.answered = true;
            void transport.acknowledge(e).catch((err) => logError(err, { phase: "ack-deadline" }));
        }, ACK_DEADLINE_MS);
        return p;
    }

    function markAnswered(p: Pending) {
        p.answered = true;
        clock.clearTimeout(p.watchdog);
    }

    /** Takes the run's pending interaction for a render (which answers it, or edits if it's already answered). */
    function takePending(run: HandlerRun): ComponentEvent | null {
        const p = run.pending;
        run.pending = null;
        if (!p) return null;
        markAnswered(p);
        return p.e;
    }

    /** Acknowledges `e` unless its pending (if it has one) was already answered. */
    async function acknowledgeOnce(e: ComponentEvent, p: Pending | null) {
        if (p) {
            if (p.answered) return;
            markAnswered(p);
        }
        await transport.acknowledge(e);
    }

    /** Ends the session; logs why and how long the root lived (the trace, if any, says which invocation). */
    function end(reason: ViewCloseReason) {
        if (stack[0]) logger.info(`view ${stack[0].def.name} closed: ${reason} after ${Date.now() - openedAt}ms`);
        ended = true;
        stopTimer();
        stack.length = 0;
    }

    function closeTransport() {
        if (sent) transport.close();
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

    /** Puts `payload` on the message: the very first time through `respond` (then the session starts listening), then through the transport. */
    async function paint(ev: ComponentEvent | null, payload: ViewPayload) {
        if (sent) {
            await transport.render(ev, payload);
            return;
        }
        if (firstSendError) throw firstSendError.err;
        try {
            await (respond as (payload: ViewPayload) => Promise<unknown>)(payload);
        } catch (err) {
            firstSendError = { err };
            end(ViewCloseReason.Failed);
            throw err;
        }
        sent = true;
        if (ended) return; // the root finished before its first send: the caller closes
        listening = true;
        transport.listen(onEvent);
        armTimer();
    }

    async function show(inst: Instance, ev: ComponentEvent | null, rendered = renderInstance(inst)) {
        onScreen = inst;
        await paint(ev, rendered.payload);
        if (listening && !ended) setText(rendered.acceptText);
    }

    async function createInstance(def: AnyView, input: unknown, opener: HandlerRun | null) {
        const state = await def.initial(input);
        let resolve!: (result: unknown) => void;
        const result = new Promise<unknown>((r) => {
            resolve = r;
        });
        const inst: Instance = { def, id: newInstanceId(), state, busy: false, run: null, resolve, opener };
        return { inst, result };
    }

    /**
     * The whole session expires: `beforeExpire` top→bottom (skipping instances whose handler is
     * running its own code - not merely parked in `open`/`modal`), then the ROOT's `onExpire` is
     * the final screen, then every open/run resolves undefined. By the time this runs, `armTimer`'s
     * callback has already confirmed nothing is running its own code (see `anyRunningOwnCode`) - the
     * `running` skip below is now mostly unreachable, kept as defense in depth.
     */
    async function expire() {
        if (ended) return;
        const root = stack[0];
        const shown = onScreen ?? root;
        const all = [...stack].reverse();
        // Snapshot before cancelling modals (a cancelled modal un-parks its handler).
        const running = new Set(all.filter(isRunningOwnCode));
        end(ViewCloseReason.Expired);
        for (const cancel of cancelModals) cancel();
        for (const inst of all) {
            if (running.has(inst)) continue;
            try {
                await inst.def.beforeExpire?.(inst.state);
            } catch (err) {
                logError(err, { view: inst.def.name, phase: "beforeExpire" });
            }
        }
        try {
            if (root && shown) await transport.render(null, await expiredPayload(root, shown));
        } catch (err) {
            logError(err, { view: root?.def.name, phase: "expire" });
        } finally {
            closeTransport();
            for (const inst of all) inst.resolve(undefined);
        }
    }

    /** The root's onExpire: a function gets the root's state; "strip"/"disable" apply to the screen shown. */
    async function expiredPayload(root: Instance, shown: Instance): Promise<ViewPayload> {
        const onExpire = root.def.onExpire ?? "strip";
        if (typeof onExpire === "function") return withDefaults(await onExpire(root.state));
        return finalPayload(shown, onExpire);
    }

    /** The instance's render with its components stripped/disabled - a closed View must show no live (dead) controls. */
    function finalPayload(inst: Instance, mode: "strip" | "disable"): ViewPayload {
        const { payload } = renderInstance(inst);
        const list = toJsonList(payload.components);
        const components = mode === "strip" ? stripInteractive(list) : disableInteractive(list);
        return { ...payload, components: components as unknown as ViewPayload["components"] };
    }

    /** `done` reached the end of its handler: the root closes the session, a child hands control back. */
    async function finish(inst: Instance, result: unknown, run: HandlerRun) {
        if (!inst.opener) {
            const payload = finalPayload(inst, "strip"); // may throw - the view then stays alive
            const ev = takePending(run);
            end(ViewCloseReason.Done);
            try {
                await paint(ev, payload);
            } finally {
                closeTransport();
                inst.resolve(result);
            }
            return;
        }
        stack.pop();
        armTimer();
        const opener = inst.opener;
        if (opener.running) {
            // The opener's handler is still awaiting `open` - its redraw answers this interaction
            // (and if it skips/fails that redraw, settleRun's stale-screen check redraws it).
            opener.pending = run.pending;
            opener.skipRedraw = false;
            run.pending = null;
        } else {
            const ev = takePending(run);
            const parent = top();
            if (parent) await show(parent, ev);
        }
        inst.resolve(result);
    }

    /** Something of the run's instance was painted: a `start` in progress lets its `open`/`run` go on. */
    function markShown(run: HandlerRun) {
        if (!run.start || run.start.ready) return;
        run.start.ready = true;
        run.start.resolve(true);
    }

    function newRun(event: ComponentEvent | TextEvent | null, user: User, pending: Pending | null, start: StartPhase | null): HandlerRun {
        let markFinished!: () => void;
        const finished = new Promise<void>((r) => {
            markFinished = r;
        });
        return { event, user, start, pending, running: true, done: null, skipRedraw: false, cancelModal: null, parked: 0, finished, markFinished };
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
            values: !run.start && e?.kind === "component" ? e.values : [],
            user: run.user,
            get raw() {
                if (!e) throw new Error(`View "${name}": c.raw isn't available in the root's start() - no interaction opened it`);
                return e.raw as HandlerContext<unknown, unknown>["raw"];
            },

            done(result) {
                if (inst !== top()) throw new Error(`View "${name}": done() called while a child view is open`);
                run.done = { result };
            },

            async open(child, input) {
                if (ended) return undefined;
                const { inst: childInst, result } = await createInstance(child as unknown as AnyView, input, run);
                if (ended) return undefined;
                if (childInst.def.start) {
                    stack.push(childInst);
                    armTimer();
                    // Rejects (child popped) if its start fails before anything is shown.
                    if (await runStart(childInst, run)) markShown(run);
                } else {
                    const rendered = renderInstance(childInst);
                    stack.push(childInst);
                    armTimer();
                    await show(childInst, takePending(run), rendered);
                    markShown(run);
                }
                run.parked++;
                try {
                    return (await result) as never;
                } finally {
                    run.parked--;
                }
            },

            async modal(spec) {
                if (ended) return null;
                if (run.start) {
                    throw new Error(`View "${name}": c.modal() can't be used in start() - there's no interaction to show it on. Show it from a button handler.`);
                }
                const clicked = run.pending;
                if (!clicked || clicked.answered || clicked.fromModalSubmit) {
                    throw new Error(
                        `View "${name}": a modal must be shown in response to a component interaction; re-show it from a button. ` +
                            `c.modal() must be the first answer to a click, within ${ACK_DEADLINE_MS}ms (not from onText, nor after notify/open/another modal, nor in answer to a modal submit).`,
                    );
                }
                const customId = viewCustomId(name, inst.id, `modal:${++modalCounter}`);
                takePending(run);
                pendingModals++;
                armTimer();
                const controller = new AbortController();
                run.parked++;
                const submitted = await new Promise<{ values: Record<string, string>; ack: ComponentEvent } | null>((resolve) => {
                    let settled = false;
                    const cancel = () => {
                        if (settled) return;
                        settled = true;
                        run.cancelModal = null;
                        cancelModals.delete(cancel);
                        controller.abort();
                        resolve(null);
                    };
                    cancelModals.add(cancel);
                    run.cancelModal = cancel;
                    const settle = (res: { values: Record<string, string>; ack: ComponentEvent } | null) => {
                        if (settled) {
                            // Submitted after it was cancelled (expiry): answer it so the user doesn't see "interaction failed".
                            if (res) void transport.acknowledge(res.ack).catch((err) => logError(err, { view: name }));
                            return;
                        }
                        settled = true;
                        run.cancelModal = null;
                        cancelModals.delete(cancel);
                        resolve(res);
                    };
                    transport.modal(clicked.e, spec, customId, config.ui.modalTimeoutMs, controller.signal).then(settle, (err) => {
                        logError(err, { view: name, phase: "modal" });
                        settle(null);
                    });
                });
                pendingModals--;
                run.parked--;
                if (ended) {
                    if (submitted) void transport.acknowledge(submitted.ack).catch((err) => logError(err, { view: name }));
                    return null;
                }
                armTimer();
                if (!submitted) {
                    logger.info(`modal "${spec.title}" closed without submitting`);
                    run.skipRedraw = true;
                    return null;
                }
                // Field keys only - values can be free text; the handler logs what it accepts.
                logger.info(`modal "${spec.title}" submitted (${Object.keys(submitted.values).join(", ")})`);
                run.pending = track(submitted.ack, true);
                return submitted.values;
            },

            async notify(content) {
                // Answers the pending interaction but keeps it: the redraw then edits through it.
                const p = run.pending;
                if (p) markAnswered(p);
                const target = p?.e ?? (run.start ? null : e);
                if (!target) {
                    logger.warn(`View "${name}": notify() in start() has no interaction to answer - ignored`, { content });
                    return;
                }
                await transport.notify(target, content).catch((err) => logError(err, { view: name }));
            },
        };
    }

    /**
     * Runs a handler (or `start`) under the instance's busy lock, then redraws / finishes / pops,
     * reporting errors to whoever interacted. A `start` that fails before anything of its instance
     * was shown fails the creation instead (`abortStart`).
     */
    async function execute(inst: Instance, run: HandlerRun, key: string, call: (c: HandlerContext<unknown, unknown>) => unknown) {
        inst.busy = true;
        inst.run = run;
        let aborted = false;
        try {
            const next = await call(makeContext(inst, run));
            if (next !== undefined) {
                inst.state = next;
                run.skipRedraw = false;
            }
            if (ended || inst !== top()) return;
            if (run.done) {
                await finish(inst, run.done.result, run);
                if (!inst.opener) markShown(run); // the root's final screen was painted
                return;
            }
            if (run.skipRedraw) return;
            await show(inst, takePending(run));
            markShown(run);
        } catch (err) {
            if (run.start && !run.start.ready) {
                aborted = true;
                abortStart(inst, run, err);
                return;
            }
            logError(err, { view: inst.def.name, key });
            const described = describeCommandError(err);
            // Answer the pending interaction but keep it, in case the stale-screen redraw below needs it.
            const p = run.pending;
            if (p) markAnswered(p);
            const target = p?.e ?? (run.start ? null : run.event);
            if (target) {
                await transport
                    .notify(target, described.kind === "user" ? described.message : getFailureQuip())
                    .catch((notifyErr) => logError(notifyErr, { view: inst.def.name }));
            }
        } finally {
            run.running = false;
            inst.busy = false;
            if (inst.run === run) inst.run = null;
            // This run no longer counts as "running its own code" - if the idle timer fired while it
            // (or something else) was, and nothing still is, that's the activity: arm a fresh timeout.
            armAfterSettle();
            if (!aborted) {
                await settleRun(run);
                if (run.start && !run.start.ready) {
                    run.start.ready = true;
                    if (firstSendError && !inst.opener) run.start.reject(firstSendError.err);
                    else run.start.resolve(false);
                }
            }
            run.markFinished();
        }
    }

    /**
     * A `start` threw before anything of its instance was shown: the creation fails like a throwing
     * `initial`. A child is popped and its opener gets its interaction back (its own error handling
     * answers it); the root's session ends before anything was sent (or the send itself failed).
     */
    function abortStart(inst: Instance, run: HandlerRun, err: unknown) {
        if (inst.opener) {
            if (top() === inst) stack.pop();
            inst.opener.pending = run.pending;
            run.pending = null;
        } else if (!ended) {
            end(ViewCloseReason.Failed);
        }
        (run.start as StartPhase).reject(err);
    }

    /**
     * Runs the instance's `start` (it must be on top of the stack already). Resolves `true` once
     * something of it is on screen - its own render, a child's, or its final screen - so
     * `open`/`run` can go on while `start` keeps running (awaiting its children); `false` if it
     * ended without painting anything (a child that was `done` at once). Rejects if it fails first.
     */
    function runStart(inst: Instance, opener: HandlerRun | null): Promise<boolean> {
        const phase = new Promise<boolean>((resolve, reject) => {
            const start: StartPhase = { ready: false, resolve, reject };
            const run = newRun(opener?.event ?? null, opener?.user ?? invoker, opener?.pending ?? null, start);
            if (opener) opener.pending = null;
            const call = inst.def.start as (c: HandlerContext<unknown, unknown>) => unknown;
            void execute(inst, run, "start", call);
        });
        return phase;
    }

    async function runHandler(
        inst: Instance,
        event: ComponentEvent | TextEvent,
        key: string,
        call: (c: HandlerContext<unknown, unknown>) => unknown,
        pending: Pending | null = null,
    ) {
        const run = newRun(event, eventUser(event), pending ?? (event.kind === "component" ? track(event) : null), null);
        await execute(inst, run, key, call);
    }

    /**
     * After a handler: if the message still shows an instance that is gone (a child popped and its
     * opener skipped or failed its redraw), redraw the top; otherwise make sure the interaction got
     * an answer. A busy top is left alone - its own handler redraws when it ends.
     */
    async function settleRun(run: HandlerRun) {
        const shown = top();
        if (!ended && sent && shown && onScreen !== shown && !shown.busy) {
            try {
                await show(shown, takePending(run));
            } catch (err) {
                logError(err, { view: shown.def.name, phase: "redraw" });
            }
        }
        const p = run.pending;
        run.pending = null;
        if (!p) return;
        const unanswered = !p.answered;
        markAnswered(p);
        if (unanswered) await transport.acknowledge(p.e).catch((err) => logError(err, { phase: "ack" }));
    }

    /**
     * `handed`: the click's pending when it's re-dispatched after cancelling a dismissed modal
     * (access was already checked, and it already owes its answer through that pending).
     */
    async function onComponent(e: ComponentEvent, handed: Pending | null = null) {
        const inst = top();
        const prefix = inst ? `${inst.def.name}:${inst.id}:` : null;
        if (ended || !inst || !prefix || !e.customId.startsWith(prefix)) {
            await acknowledgeOnce(e, handed);
            return;
        }
        if (!handed && !isAllowed(inst.def, e, invoker.id)) {
            await transport.notify(e, NOT_YOURS);
            return;
        }
        armTimer();
        const key = e.customId.slice(prefix.length);
        const handler = inst.def.on?.[key];
        if (inst.busy) {
            // Discord never reports a dismissed modal: a new click means the user left it. Cancel
            // it (the parked handler resumes with null and ends), then handle this click normally.
            const parked = inst.run;
            if (!handed && parked?.cancelModal) {
                const p = track(e);
                parked.cancelModal();
                await parked.finished;
                await onComponent(e, p);
                return;
            }
            await acknowledgeOnce(e, handed);
            return;
        }
        if (!handler) {
            await acknowledgeOnce(e, handed);
            return;
        }
        await runHandler(inst, e, key, handler, handed);
    }

    async function onText(e: TextEvent) {
        const inst = top();
        const onTextHandler = inst?.def.onText;
        if (ended || !textListening || !inst || !onTextHandler || inst.busy) return;
        // Someone else's message isn't an answer to this View - ignore it silently.
        if (!isAllowed(inst.def, e, invoker.id)) return;
        armTimer();
        const deleteInput = inst.def.deleteTextInput;
        // The delete runs inside the handler run, so the busy lock is already held: a second quick reply is dropped.
        await runHandler(inst, e, "text", async (c) => {
            if (deleteInput) await transport.deleteText(e).catch(() => {});
            return onTextHandler(Object.assign(c, { text: e.content }));
        });
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
        async run<S, R, I>(view: ViewDefinition<S, R, I>, input: I, send: (payload: ViewPayload) => Promise<unknown>) {
            if (respond) throw new Error("A ViewSession runs a single root view");
            respond = send;
            openedAt = Date.now();
            const { inst, result } = await createInstance(view as unknown as AnyView, input, null);
            stack.push(inst);
            try {
                if (inst.def.start) await runStart(inst, null);
                else await show(inst, null);
            } catch (err) {
                if (!ended) end(ViewCloseReason.Failed);
                throw err;
            }
            if (!sent) throw (firstSendError?.err ?? new Error(`View "${inst.def.name}": its start() ended without anything being sent`));
            return result as Promise<R | undefined>;
        },
    };
}
