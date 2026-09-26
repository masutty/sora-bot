/**
 * An in-memory ViewTransport + manual clock for engine/helper tests: records every call and lets
 * the test emit clicks, typed replies and modal submits. TEST-ONLY: modules get it from
 * `@/define` as `createFakeViewTransport` for their View tests; never use it in runtime code.
 */
import type { User } from "discord.js";
import type { ModalSpec, ViewDefinition, ViewPayload } from "./view";
import { type ComponentEvent, createViewSession, type TextEvent, type ViewClock, type ViewTransport } from "./view-engine";

type ModalResult = { values: Record<string, string>; ack: ComponentEvent } | null;

export interface ManualClock extends ViewClock {
    /** Moves time forward, firing every timer that comes due (in order), then lets the engine settle. */
    advance(ms: number): Promise<void>;
}

export interface FakeTransport extends ViewTransport {
    /** Pass as the session's `respond`. */
    respond: (payload: ViewPayload) => Promise<void>;
    responded: ViewPayload[];
    renders: { e: ComponentEvent | null; payload: ViewPayload }[];
    acks: ComponentEvent[];
    notifies: { e: ComponentEvent | TextEvent; content: string }[];
    /** `signal`: aborted when the engine cancels the modal (a new click after a dismissed modal, or expiry). */
    modals: { e: ComponentEvent; spec: ModalSpec; customId: string; timeoutMs: number; signal: AbortSignal | undefined }[];
    deletedTexts: TextEvent[];
    closed: number;
    textListening: boolean;
    /** Method names in call order (respond, render, acknowledge, notify, modal, deleteText, close). */
    log: string[];
    /**
     * What the next `modal()` resolves with. Default: closed (`null`). It ignores the abort signal
     * on purpose (the engine must cope with a transport that settles late).
     */
    modalResult: (call: { e: ComponentEvent; customId: string }) => Promise<ModalResult>;
    clock: ManualClock;
    /** The payload currently on the message (last respond/render). */
    lastPayload(): ViewPayload;
    /** The customId bound to `key` on the current message. */
    id(key: string): string;
    /** A click on the current message's component bound to `key`. */
    click(key: string, userId: string, values?: string[]): ComponentEvent;
    /** A click on an exact customId (e.g. one captured from an earlier render). */
    clickId(customId: string, userId: string, values?: string[]): ComponentEvent;
    text(userId: string, content: string): TextEvent;
    /** A modal submit, to return as `ack` from `modalResult`. */
    modalSubmit(userId: string): ComponentEvent;
    /** Delivers an event and waits until the engine settles (not until the handler ends: it may be awaiting a child view). */
    emit(e: ComponentEvent | TextEvent): Promise<void>;
    /** Lets every pending promise chain settle. */
    flush(): Promise<void>;
    /**
     * Runs `view` as the root of a session on this transport and its manual clock, owned by
     * `invokerId` (default "owner"). Resolves like `runView`: the `done` result, or `undefined` on expiry.
     */
    run<S, R, I>(view: ViewDefinition<S, R, I>, input: I, invokerId?: string): Promise<R | undefined>;
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Every customId in a payload, depth-first (works on builders and on raw JSON). */
export function customIds(payload: ViewPayload): string[] {
    const out: string[] = [];
    const walk = (node: unknown) => {
        if (node === null || typeof node !== "object") return;
        const json = typeof (node as { toJSON?: unknown }).toJSON === "function" ? (node as { toJSON(): unknown }).toJSON() : node;
        if (Array.isArray(json)) {
            for (const child of json) walk(child);
            return;
        }
        const obj = json as Record<string, unknown>;
        if (typeof obj.custom_id === "string") out.push(obj.custom_id);
        walk(obj.components);
        walk(obj.accessory);
    };
    walk(payload.components);
    return out;
}

function createManualClock(): ManualClock {
    let now = 0;
    let nextHandle = 0;
    const timers = new Map<number, { at: number; fn: () => void }>();
    return {
        setTimeout(fn, ms) {
            const handle = ++nextHandle;
            timers.set(handle, { at: now + ms, fn });
            return handle;
        },
        clearTimeout(handle) {
            timers.delete(handle as number);
        },
        async advance(ms) {
            const target = now + ms;
            for (;;) {
                const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
                if (!due) break;
                timers.delete(due[0]);
                now = due[1].at;
                due[1].fn();
                await settle();
            }
            now = target;
            await settle();
        },
    };
}

export function createFakeTransport(): FakeTransport {
    let listener: ((e: ComponentEvent | TextEvent) => Promise<void>) | null = null;

    const fake: FakeTransport = {
        responded: [],
        renders: [],
        acks: [],
        notifies: [],
        modals: [],
        deletedTexts: [],
        closed: 0,
        textListening: false,
        log: [],
        modalResult: async () => null,
        clock: createManualClock(),

        async respond(payload) {
            fake.log.push("respond");
            fake.responded.push(payload);
        },

        listen(onEvent) {
            listener = onEvent;
        },
        setTextListening(on) {
            fake.textListening = on;
        },
        async render(e, payload) {
            fake.log.push("render");
            fake.renders.push({ e, payload });
        },
        async acknowledge(e) {
            fake.log.push("acknowledge");
            fake.acks.push(e);
        },
        async notify(e, content) {
            fake.log.push("notify");
            fake.notifies.push({ e, content });
        },
        async modal(e, spec, customId, timeoutMs, signal) {
            fake.log.push("modal");
            fake.modals.push({ e, spec, customId, timeoutMs, signal });
            return fake.modalResult({ e, customId });
        },
        async deleteText(e) {
            fake.log.push("deleteText");
            fake.deletedTexts.push(e);
        },
        close() {
            fake.log.push("close");
            fake.closed++;
            listener = null;
        },

        lastPayload() {
            const last = fake.renders.at(-1)?.payload ?? fake.responded.at(-1);
            if (!last) throw new Error("Nothing was rendered yet");
            return last;
        },
        id(key) {
            const id = customIds(fake.lastPayload()).find((c) => c.endsWith(`:${key}`));
            if (!id) throw new Error(`No component bound to "${key}" on the current message`);
            return id;
        },
        click(key, userId, values = []) {
            return fake.clickId(fake.id(key), userId, values);
        },
        clickId(customId, userId, values = []) {
            return { kind: "component", customId, userId, values, raw: { user: { id: userId } } };
        },
        text(userId, content) {
            return { kind: "text", userId, content, raw: { author: { id: userId }, content } };
        },
        modalSubmit(userId) {
            return { kind: "component", customId: "modal-submit", userId, values: [], raw: { user: { id: userId } } };
        },

        async emit(e) {
            if (!listener) throw new Error("The transport isn't listening (not started, or closed)");
            void listener(e);
            await settle();
        },
        flush: settle,
        run(view, input, invokerId = "owner") {
            return createViewSession(fake, { id: invokerId } as User, fake.clock).run(view, input, fake.respond);
        },
    };
    return fake;
}
