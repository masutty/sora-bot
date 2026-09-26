import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { ButtonBuilder, ButtonStyle, ContainerBuilder, MessageFlags, SectionBuilder, TextDisplayBuilder } from "discord.js";
import { Logger } from "@/utils/logging";
import { UserFacingError } from "../command/user-facing-error";
import { createFakeTransport, customIds, type FakeTransport } from "./fake-transport";
import { defineView, type HandlerContext, type ViewDefinition } from "./view";
import { ACK_DEADLINE_MS, type ComponentEvent } from "./view-engine";

const OWNER = "owner";
const OTHER = "other";
const TIMEOUT = 1_000;
/** discord.js refuses to serialize a button without a label. */
const label = (b: ButtonBuilder) => b.setLabel("x");

let fake: FakeTransport;
let logError: ReturnType<typeof spyOn>;

beforeEach(() => {
    fake = createFakeTransport();
    // Test 13 logs on purpose - keep the output clean and let tests assert on it.
    logError = spyOn(Logger.prototype, "error").mockImplementation(() => {});
});

afterEach(() => {
    logError.mockRestore();
});

function start<S, R, I>(view: ViewDefinition<S, R, I>, input: I, invokerId = OWNER) {
    return fake.run(view, input, invokerId);
}

/** A counter with a button per interesting behavior. */
const counter = defineView<{ n: number }, number, number>({
    name: "test.counter",
    initial: (n) => ({ n }),
    render: (s, kit) => ({ content: `n=${s.n}`, components: [kit.row(kit.button("inc", label), kit.button("set", label), kit.button("finish", label))] }),
    timeoutMs: TIMEOUT,
    on: {
        inc: (c) => {
            c.state.n++;
        },
        set: () => ({ n: 100 }),
        finish: (c) => c.done(c.state.n),
    },
});

test("1. initial render: respond is called once with render(initial), ids become <name>:<inst>:<key>", async () => {
    void start(counter, 5);
    await fake.flush();

    expect(fake.responded).toHaveLength(1);
    expect(fake.responded[0].content).toBe("n=5");
    const ids = customIds(fake.responded[0]);
    expect(ids).toHaveLength(3);
    for (const [i, key] of ["inc", "set", "finish"].entries()) {
        expect(ids[i]).toMatch(new RegExp(`^test\\.counter:[a-z0-9]+:${key}$`));
    }
    // One instance: every id shares the same instance segment.
    expect(new Set(ids.map((id) => id.split(":")[1])).size).toBe(1);
    // Every View payload defaults to no pings.
    expect(fake.responded[0].allowedMentions).toEqual({ parse: [] });
    expect(fake.renders).toHaveLength(0);
});

test("2. owner click on k runs on.k and answers with a single render(e, newPayload)", async () => {
    void start(counter, 5);
    await fake.flush();

    const e = fake.click("inc", OWNER);
    await fake.emit(e);

    expect(fake.renders).toHaveLength(1);
    expect(fake.renders[0].e).toBe(e);
    expect(fake.renders[0].payload.content).toBe("n=6");
    expect(fake.acks).toHaveLength(0);
    expect(fake.notifies).toHaveLength(0);
});

test("3. a handler that mutates redraws with the mutation; one that returns a state replaces it", async () => {
    void start(counter, 5);
    await fake.flush();

    await fake.emit(fake.click("inc", OWNER));
    expect(fake.lastPayload().content).toBe("n=6");

    await fake.emit(fake.click("set", OWNER));
    expect(fake.lastPayload().content).toBe("n=100");

    await fake.emit(fake.click("inc", OWNER));
    expect(fake.lastPayload().content).toBe("n=101");
});

test("4. someone else's click gets \"This isn't yours!\", the handler doesn't run and the timer doesn't renew", async () => {
    const result = start(counter, 5);
    await fake.flush();

    await fake.clock.advance(TIMEOUT - 1);
    const e = fake.click("inc", OTHER);
    await fake.emit(e);

    expect(fake.notifies).toEqual([{ e, content: "This isn't yours!" }]);
    expect(fake.renders).toHaveLength(0);

    await fake.clock.advance(1);
    expect(await result).toBeUndefined();
    expect(fake.closed).toBe(1);
});

test("5. access: \"anyone\" lets someone else's click run the handler", async () => {
    void start(defineView({ ...counter, access: "anyone" }), 5);
    await fake.flush();

    await fake.emit(fake.click("inc", OTHER));

    expect(fake.notifies).toHaveLength(0);
    expect(fake.lastPayload().content).toBe("n=6");
});

test("6. done(x) resolves the run with x; the transport gets the final render and then close", async () => {
    const result = start(counter, 7);
    await fake.flush();

    const e = fake.click("finish", OWNER);
    await fake.emit(e);

    expect(await result).toBe(7);
    expect(fake.renders).toHaveLength(1);
    expect(fake.renders[0].e).toBe(e);
    // The final screen keeps the content but no live (dead after close) components.
    expect(fake.renders[0].payload.content).toBe("n=7");
    expect(customIds(fake.renders[0].payload)).toEqual([]);
    expect(fake.log.slice(-2)).toEqual(["render", "close"]);
    expect(fake.closed).toBe(1);
});

test("7. child view: shown on the same message, stale parent clicks are acknowledged, done(y) resolves open and the parent redraws", async () => {
    const child = defineView<{ label: string }, string, string>({
        name: "test.child",
        initial: (label) => ({ label }),
        render: (s, kit) => ({ content: `child ${s.label}`, components: [kit.row(kit.button("pick", label))] }),
        on: { pick: (c) => c.done(`picked-${c.state.label}`) },
    });
    let parentHandlerRuns = 0;
    const parent = defineView<{ picked: string | undefined }, void>({
        name: "test.parent",
        initial: () => ({ picked: undefined }),
        render: (s, kit) => ({ content: `parent ${s.picked ?? "-"}`, components: [kit.row(kit.button("choose", label))] }),
        on: {
            choose: async (c) => {
                parentHandlerRuns++;
                c.state.picked = await c.open(child, "x");
            },
        },
    });
    void start(parent, undefined);
    await fake.flush();
    const parentId = fake.id("choose");

    await fake.emit(fake.click("choose", OWNER));
    expect(fake.lastPayload().content).toBe("child x");
    expect(fake.renders).toHaveLength(1);

    // A click on the parent's (no longer shown) button: acknowledged and ignored.
    const stale = fake.clickId(parentId, OWNER);
    await fake.emit(stale);
    expect(fake.acks).toEqual([stale]);
    expect(parentHandlerRuns).toBe(1);

    const pick = fake.click("pick", OWNER);
    await fake.emit(pick);

    expect(fake.lastPayload().content).toBe("parent picked-x");
    // The child's click is answered exactly once: by the parent's redraw.
    expect(fake.renders.filter((r) => r.e === pick)).toHaveLength(1);
    expect(fake.renders).toHaveLength(2);
    expect(fake.acks).toEqual([stale]);
    expect(fake.closed).toBe(0);
    // The parent is interactive again.
    expect(fake.id("choose")).toBe(parentId);
});

test("8. idle timeout renews on accepted clicks and expires without them: beforeExpire, strip, close, undefined", async () => {
    const order: string[] = [];
    const view = defineView({
        ...counter,
        beforeExpire: async (s: { n: number }) => {
            order.push(`beforeExpire n=${s.n}`);
        },
    });
    const result = start(view, 1);
    await fake.flush();

    await fake.clock.advance(TIMEOUT - 1);
    await fake.emit(fake.click("inc", OWNER));
    await fake.clock.advance(TIMEOUT - 1);
    expect(fake.closed).toBe(0);

    fake.log.length = 0;
    await fake.clock.advance(1);

    expect(order).toEqual(["beforeExpire n=2"]);
    expect(fake.log).toEqual(["render", "close"]);
    const final = fake.renders.at(-1);
    expect(final?.e).toBeNull();
    expect(final?.payload.content).toBe("n=2");
    expect(final?.payload.components).toEqual([]);
    expect(await result).toBeUndefined();
});

test("9. onExpire as a function: its payload is the final one", async () => {
    const result = start(defineView({ ...counter, onExpire: (s: { n: number }) => ({ content: `expired at ${s.n}` }) }), 3);
    await fake.flush();

    await fake.clock.advance(TIMEOUT);

    expect(fake.lastPayload().content).toBe("expired at 3");
    expect(fake.lastPayload().allowedMentions).toEqual({ parse: [] });
    expect(await result).toBeUndefined();
});

test("10. typed replies: ignored without acceptText; owner text runs onText; others are silently ignored; deleteTextInput deletes", async () => {
    const view = defineView<{ name: string; asking: boolean }, void>({
        name: "test.text",
        initial: () => ({ name: "-", asking: false }),
        render: (s, kit) => ({ content: `name=${s.name}`, components: [kit.row(kit.button("ask", label))], acceptText: s.asking }),
        on: {
            ask: (c) => {
                c.state.asking = true;
            },
        },
        onText: (c) => ({ name: c.text, asking: false }),
        deleteTextInput: true,
    });
    void start(view, undefined);
    await fake.flush();

    await fake.emit(fake.text(OWNER, "ignored"));
    expect(fake.lastPayload().content).toBe("name=-");
    expect(fake.renders).toHaveLength(0);
    expect(fake.textListening).toBe(false);

    await fake.emit(fake.click("ask", OWNER));
    expect(fake.textListening).toBe(true);

    await fake.emit(fake.text(OTHER, "intruder"));
    expect(fake.notifies).toHaveLength(0);
    expect(fake.deletedTexts).toHaveLength(0);
    expect(fake.renders).toHaveLength(1);

    const reply = fake.text(OWNER, "sora");
    await fake.emit(reply);
    expect(fake.lastPayload().content).toBe("name=sora");
    expect(fake.renders.at(-1)?.e).toBeNull();
    expect(fake.deletedTexts).toEqual([reply]);
    expect(fake.textListening).toBe(false);
});

test("11. modal: delegates to the transport; values redraw through the submit's ack; null leaves the message alone", async () => {
    const view = defineView<{ name: string }, void>({
        name: "test.modal",
        initial: () => ({ name: "-" }),
        render: (s, kit) => ({ content: `name=${s.name}`, components: [kit.row(kit.button("rename", label))] }),
        on: {
            rename: async (c) => {
                const v = await c.modal({ title: "Rename", fields: [{ key: "name", label: "Name" }] });
                if (!v) return;
                c.state.name = v.name;
            },
        },
    });
    void start(view, undefined);
    await fake.flush();

    const ack = fake.modalSubmit(OWNER);
    fake.modalResult = async () => ({ values: { name: "sora" }, ack });
    const click = fake.click("rename", OWNER);
    await fake.emit(click);

    expect(fake.modals).toHaveLength(1);
    expect(fake.modals[0].e).toBe(click);
    expect(fake.modals[0].spec.title).toBe("Rename");
    expect(fake.modals[0].customId).toMatch(/^test\.modal:[a-z0-9]+:modal:\d+$/);
    expect(fake.renders).toEqual([{ e: ack, payload: fake.lastPayload() }]);
    expect(fake.lastPayload().content).toBe("name=sora");

    fake.modalResult = async () => null;
    await fake.emit(fake.click("rename", OWNER));
    expect(fake.modals).toHaveLength(2);
    expect(fake.renders).toHaveLength(1);
    expect(fake.acks).toHaveLength(0);
});

test("12. a customId over 100 chars makes render throw, naming the view and the key", async () => {
    const key = "k".repeat(100);
    const view = defineView<null, void>({
        name: "test.long",
        initial: () => null,
        render: (_s, kit) => ({ components: [kit.row(kit.button(key, label))] }),
    });

    const run = start(view, undefined);

    await expect(run).rejects.toThrow(/test\.long/);
    await expect(run).rejects.toThrow(key);
    expect(fake.responded).toHaveLength(0);
});

test("13. a handler error is logged, the owner is notified (message for UserFacingError, a quip otherwise) and the view stays alive", async () => {
    const view = defineView({
        ...counter,
        on: {
            ...counter.on,
            user: () => {
                throw new UserFacingError("That biome doesn't exist.");
            },
            boom: () => {
                throw new Error("ECONNREFUSED 10.0.0.3:5432");
            },
        },
    });
    void start(view, 0);
    await fake.flush();
    const idFor = (key: string) => fake.id("inc").replace(/:inc$/, `:${key}`);

    const u = fake.clickId(idFor("user"), OWNER);
    await fake.emit(u);
    expect(fake.notifies).toEqual([{ e: u, content: "That biome doesn't exist." }]);

    const b = fake.clickId(idFor("boom"), OWNER);
    await fake.emit(b);
    expect(fake.notifies).toHaveLength(2);
    expect(fake.notifies[1].e).toBe(b);
    expect(fake.notifies[1].content).not.toContain("ECONNREFUSED");
    expect(fake.notifies[1].content.length).toBeGreaterThan(0);

    expect(logError).toHaveBeenCalledTimes(2);

    await fake.emit(fake.click("inc", OWNER));
    expect(fake.lastPayload().content).toBe("n=1");
    expect(fake.closed).toBe(0);
});

test("onExpire \"disable\" keeps the components but disables them; \"strip\" reaches rows nested in a ComponentsV2 container", async () => {
    const v2 = defineView<null, void>({
        name: "test.v2",
        initial: () => null,
        render: (_s, kit) => ({
            flags: MessageFlags.IsComponentsV2,
            components: [
                new ContainerBuilder()
                    .addTextDisplayComponents(new TextDisplayBuilder().setContent("hello"))
                    .addActionRowComponents(kit.row(kit.button("a", label))),
            ],
        }),
        timeoutMs: TIMEOUT,
    });

    void start(v2, undefined);
    await fake.flush();
    await fake.clock.advance(TIMEOUT);
    expect(fake.lastPayload().components).toEqual([{ type: 17, components: [{ type: 10, content: "hello" }] }]);

    fake = createFakeTransport();
    void start(defineView({ ...v2, onExpire: "disable" }), undefined);
    await fake.flush();
    await fake.clock.advance(TIMEOUT);
    const container = fake.lastPayload().components?.[0] as { components: { type: number; components?: { disabled?: boolean }[] }[] };
    expect(container.components[1].components?.[0].disabled).toBe(true);
    expect(customIds(fake.lastPayload())).toHaveLength(1);
});

// ─── Fix round 1: stale child screen, modal vs idle timer, 3s window, concurrency ───

function deferred<T = void>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

type ModalResult = { values: Record<string, string>; ack: ComponentEvent } | null;

const pickChild = defineView<null, string>({
    name: "test.child",
    initial: () => null,
    render: (_s, kit) => ({ content: "child", components: [kit.row(kit.button("pick", label))] }),
    on: { pick: (c) => c.done("y") },
});

/** A parent whose `choose` opens `pickChild`, bumps n, then runs `after`. */
function parentThen(after: (c: HandlerContext<{ n: number }, void>) => Promise<unknown>) {
    return defineView<{ n: number }, void>({
        name: "test.parent",
        initial: () => ({ n: 0 }),
        render: (s, kit) => ({ content: `parent n=${s.n}`, components: [kit.row(kit.button("choose", label))] }),
        on: {
            choose: async (c) => {
                await c.open(pickChild, null);
                c.state.n++;
                await after(c);
            },
        },
    });
}

test("child done, then the parent's modal is dismissed: the parent is redrawn (not stuck on the child's screen)", async () => {
    void start(parentThen((c) => c.modal({ title: "t", fields: [{ key: "a", label: "a" }] })), undefined);
    await fake.flush();
    const parentId = fake.id("choose");

    await fake.emit(fake.click("choose", OWNER));
    const pick = fake.click("pick", OWNER);
    await fake.emit(pick);

    expect(fake.modals).toHaveLength(1);
    expect(fake.modals[0].e).toBe(pick);
    expect(fake.lastPayload().content).toBe("parent n=1");
    expect(fake.renders.at(-1)?.e).toBeNull();
    expect(fake.id("choose")).toBe(parentId);
    expect(fake.acks).toHaveLength(0);
});

test("child done, then the parent's handler throws: the parent is redrawn and the owner notified", async () => {
    void start(
        parentThen(async () => {
            throw new UserFacingError("nope");
        }),
        undefined,
    );
    await fake.flush();

    await fake.emit(fake.click("choose", OWNER));
    const pick = fake.click("pick", OWNER);
    await fake.emit(pick);

    expect(fake.notifies).toEqual([{ e: pick, content: "nope" }]);
    expect(fake.lastPayload().content).toBe("parent n=1");
    expect(fake.renders.filter((r) => r.e === pick)).toHaveLength(1);
    expect(fake.acks).toHaveLength(0);
    expect(fake.closed).toBe(0);
});

function renamer(timeoutMs: number, seen: unknown[] = []) {
    return defineView<{ name: string }, void>({
        name: "test.rename",
        initial: () => ({ name: "-" }),
        render: (s, kit) => ({ content: `name=${s.name}`, components: [kit.row(kit.button("rename", label))] }),
        timeoutMs,
        on: {
            rename: async (c) => {
                const v = await c.modal({ title: "Rename", fields: [{ key: "name", label: "Name" }] });
                seen.push(v);
                if (v) c.state.name = v.name;
            },
        },
    });
}

test("the idle timer is paused while a modal is open: a 20s view survives 30s of typing", async () => {
    const submit = deferred<ModalResult>();
    fake.modalResult = () => submit.promise;
    void start(renamer(20_000), undefined);
    await fake.flush();

    await fake.emit(fake.click("rename", OWNER));
    await fake.clock.advance(30_000);
    expect(fake.closed).toBe(0);

    const ack = fake.modalSubmit(OWNER);
    submit.resolve({ values: { name: "sora" }, ack });
    await fake.flush();

    expect(fake.renders.at(-1)?.e).toBe(ack);
    expect(fake.lastPayload().content).toBe("name=sora");

    // Resumed after the submit: the normal idle timeout applies again.
    await fake.clock.advance(20_000);
    expect(fake.closed).toBe(1);
});

test("a slow handler: the click is acknowledged before Discord's 3s window closes, then rendered once without a second ack", async () => {
    const gate = deferred();
    const view = defineView<{ n: number }, void>({
        name: "test.slow",
        initial: () => ({ n: 0 }),
        render: (s, kit) => ({ content: `n=${s.n}`, components: [kit.row(kit.button("slow", label))] }),
        timeoutMs: 10_000,
        on: {
            slow: async (c) => {
                await gate.promise;
                c.state.n = 1;
            },
        },
    });
    void start(view, undefined);
    await fake.flush();

    const e = fake.click("slow", OWNER);
    await fake.emit(e);
    await fake.clock.advance(ACK_DEADLINE_MS - 1);
    expect(fake.acks).toHaveLength(0);
    await fake.clock.advance(1);
    expect(fake.acks).toEqual([e]);

    await fake.clock.advance(500);
    gate.resolve();
    await fake.flush();

    expect(fake.renders).toHaveLength(1);
    expect(fake.renders[0].e).toBe(e);
    expect(fake.lastPayload().content).toBe("n=1");
    expect(fake.acks).toEqual([e]);
});

test("expiry while a modal is pending (the transport never answered): the modal resolves null, a late submit is acknowledged", async () => {
    const submit = deferred<ModalResult>();
    fake.modalResult = () => submit.promise;
    const seen: unknown[] = [];
    const result = start(renamer(1_000, seen), undefined);
    await fake.flush();

    await fake.emit(fake.click("rename", OWNER));
    await fake.clock.advance(10 * 60_000);

    expect(await result).toBeUndefined();
    expect(seen).toEqual([null]);
    expect(fake.closed).toBe(1);

    const ack = fake.modalSubmit(OWNER);
    submit.resolve({ values: { name: "late" }, ack });
    await fake.flush();
    expect(fake.acks).toEqual([ack]);
    expect(fake.renders.filter((r) => r.e === ack)).toHaveLength(0);
});

test("expiry while a child is open: open() and the run both resolve undefined, one final render", async () => {
    const opened: unknown[] = [];
    const parent = defineView<null, void>({
        name: "test.parent",
        initial: () => null,
        render: (_s, kit) => ({ content: "parent", components: [kit.row(kit.button("choose", label))] }),
        on: {
            choose: async (c) => {
                opened.push(await c.open(pickChild, null));
            },
        },
    });
    const result = start(parent, undefined);
    await fake.flush();
    await fake.emit(fake.click("choose", OWNER));
    const rendersBefore = fake.renders.length;

    await fake.clock.advance(60_000);

    expect(await result).toBeUndefined();
    expect(opened).toEqual([undefined]);
    expect(fake.renders.length - rendersBefore).toBe(1);
    expect(fake.lastPayload().content).toBe("child");
    expect(customIds(fake.lastPayload())).toEqual([]);
    expect(fake.closed).toBe(1);
});

test("a click while a handler is still running is acknowledged and doesn't run the handler twice", async () => {
    const gate = deferred();
    let runs = 0;
    const view = defineView<{ n: number }, void>({
        name: "test.busy",
        initial: () => ({ n: 0 }),
        render: (s, kit) => ({ content: `n=${s.n}`, components: [kit.row(kit.button("go", label))] }),
        on: {
            go: async (c) => {
                runs++;
                await gate.promise;
                c.state.n++;
            },
        },
    });
    void start(view, undefined);
    await fake.flush();

    const first = fake.click("go", OWNER);
    const second = fake.click("go", OWNER);
    await fake.emit(first);
    await fake.emit(second);
    expect(fake.acks).toEqual([second]);

    gate.resolve();
    await fake.flush();
    expect(runs).toBe(1);
    expect(fake.renders).toEqual([{ e: first, payload: fake.lastPayload() }]);
    expect(fake.lastPayload().content).toBe("n=1");
});

// ─── Checkpoint fix wave ────────────────────────────────────────────────────

const step = defineView<null, string>({
    name: "test.step",
    initial: () => null,
    render: (_s, kit) => ({ content: "step", components: [kit.row(kit.button("pick", label))] }),
    on: { pick: (c) => c.done("a") },
});

test("C1. start: a root whose start opens a child sends the child's render first; child done -> the root is redrawn", async () => {
    const flow = defineView<{ got: string | undefined }, void>({
        name: "test.flow",
        initial: () => ({ got: undefined }),
        render: (s, kit) => ({ content: `flow ${s.got ?? "-"}`, components: [kit.row(kit.button("again", label))] }),
        start: async (c) => {
            c.state.got = await c.open(step, null);
        },
    });
    void start(flow, undefined);
    await fake.flush();

    expect(fake.responded).toHaveLength(1);
    expect(fake.responded[0].content).toBe("step");
    expect(fake.renders).toHaveLength(0);

    const pick = fake.click("pick", OWNER);
    await fake.emit(pick);

    expect(fake.renders).toEqual([{ e: pick, payload: fake.lastPayload() }]);
    expect(fake.lastPayload().content).toBe("flow a");
    expect(fake.acks).toHaveLength(0);
    expect(customIds(fake.lastPayload())).toHaveLength(1);
});

test("C1. start: state mutated or returned by the root's start is in the first render", async () => {
    void start(
        defineView({
            ...counter,
            start: (c: HandlerContext<{ n: number }, number>) => {
                c.state.n++;
            },
        }),
        5,
    );
    await fake.flush();
    expect(fake.responded.map((p) => p.content)).toEqual(["n=6"]);

    fake = createFakeTransport();
    void start(defineView({ ...counter, start: async () => ({ n: 42 }) }), 5);
    await fake.flush();
    expect(fake.responded.map((p) => p.content)).toEqual(["n=42"]);
});

test("C1. start: a root that calls done before anything is sent renders once (stripped), then resolves", async () => {
    const result = start(defineView({ ...counter, start: (c: HandlerContext<{ n: number }, number>) => c.done(9) }), 9);
    expect(await result).toBe(9);
    expect(fake.responded).toHaveLength(1);
    expect(fake.responded[0].content).toBe("n=9");
    expect(customIds(fake.responded[0])).toEqual([]);
    expect(fake.renders).toHaveLength(0);
});

test("C1. start: a child with start, opened from a click, answers that click with its own child's render", async () => {
    const inner = defineView<null, string>({
        name: "test.inner",
        initial: () => null,
        render: () => ({ content: "inner-self" }),
        start: async (c) => {
            const r = await c.open(step, null);
            c.done(`inner-${r}`);
        },
    });
    const parent = defineView<{ r: string | undefined }, void>({
        name: "test.parent",
        initial: () => ({ r: undefined }),
        render: (s, kit) => ({ content: `parent ${s.r ?? "-"}`, components: [kit.row(kit.button("go", label))] }),
        on: {
            go: async (c) => {
                c.state.r = await c.open(inner, null);
            },
        },
    });
    void start(parent, undefined);
    await fake.flush();

    const go = fake.click("go", OWNER);
    await fake.emit(go);
    expect(fake.renders).toEqual([{ e: go, payload: fake.lastPayload() }]);
    expect(fake.lastPayload().content).toBe("step");

    const pick = fake.click("pick", OWNER);
    await fake.emit(pick);
    expect(fake.renders.filter((r) => r.e === pick)).toHaveLength(1);
    expect(fake.lastPayload().content).toBe("parent inner-a");
    expect(fake.acks).toHaveLength(0);
    expect(fake.notifies).toHaveLength(0);
});

test("C1. start: notify with no interaction is a no-op; modal throws a clear error (the root's run rejects)", async () => {
    void start(
        defineView({
            ...counter,
            start: async (c: HandlerContext<{ n: number }, number>) => {
                await c.notify("hi");
            },
        }),
        1,
    );
    await fake.flush();
    expect(fake.notifies).toHaveLength(0);
    expect(fake.responded).toHaveLength(1);

    fake = createFakeTransport();
    const run = start(
        defineView({
            ...counter,
            start: async (c: HandlerContext<{ n: number }, number>) => {
                await c.modal({ title: "t", fields: [{ key: "a", label: "a" }] });
            },
        }),
        1,
    );
    await expect(run).rejects.toThrow(/start/);
    expect(fake.responded).toHaveLength(0);
    expect(fake.modals).toHaveLength(0);
});

test("C1. start: a child whose start throws before rendering makes open reject; the click is answered once (notify)", async () => {
    const broken = defineView<null, void>({
        name: "test.broken",
        initial: () => null,
        render: () => ({ content: "broken" }),
        start: () => {
            throw new UserFacingError("cannot start");
        },
    });
    const parent = defineView<null, void>({
        name: "test.parent",
        initial: () => null,
        render: (_s, kit) => ({ content: "parent", components: [kit.row(kit.button("go", label))] }),
        on: {
            go: async (c) => {
                await c.open(broken, null);
            },
        },
    });
    void start(parent, undefined);
    await fake.flush();

    const go = fake.click("go", OWNER);
    await fake.emit(go);
    expect(fake.notifies).toEqual([{ e: go, content: "cannot start" }]);
    expect(fake.renders).toHaveLength(0);
    expect(fake.acks).toHaveLength(0);
    // The parent is still the live screen.
    await fake.emit(fake.click("go", OWNER));
    expect(fake.notifies).toHaveLength(2);
});

test("I1. the idle clock is the root's: a 20s child inside a 300s root doesn't expire at 25s", async () => {
    const confirm = defineView<null, boolean>({
        name: "test.confirm",
        initial: () => null,
        render: (_s, kit) => ({ content: "sure?", components: [kit.row(kit.button("yes", label))] }),
        timeoutMs: 20_000,
        onExpire: () => ({ content: "confirm expired" }),
        on: { yes: (c) => c.done(true) },
    });
    const root = defineView<null, void>({
        name: "test.root",
        initial: () => null,
        render: (_s, kit) => ({ content: "root", components: [kit.row(kit.button("ask", label))] }),
        timeoutMs: 300_000,
        on: {
            ask: async (c) => {
                await c.open(confirm, null);
            },
        },
    });
    const result = start(root, undefined);
    await fake.flush();
    await fake.emit(fake.click("ask", OWNER));

    await fake.clock.advance(25_000);
    expect(fake.closed).toBe(0);
    expect(fake.lastPayload().content).toBe("sure?");

    await fake.clock.advance(300_000);
    expect(fake.closed).toBe(1);
    expect(await result).toBeUndefined();
    // The root's onExpire (default "strip") applies to the shown screen, not the child's function.
    expect(fake.lastPayload().content).toBe("sure?");
    expect(customIds(fake.lastPayload())).toEqual([]);
});

test("I1. the root's onExpire function is the final payload even while a child is on top; the child's beforeExpire still runs", async () => {
    const order: string[] = [];
    const child = defineView<null, string>({
        ...step,
        onExpire: () => ({ content: "child expired" }),
        beforeExpire: async () => void order.push("child"),
    });
    const root = defineView<{ n: number }, void>({
        name: "test.root",
        initial: () => ({ n: 7 }),
        render: (_s, kit) => ({ content: "root", components: [kit.row(kit.button("ask", label))] }),
        timeoutMs: TIMEOUT,
        onExpire: (s) => ({ content: `root expired at ${s.n}` }),
        on: {
            ask: async (c) => {
                await c.open(child, null);
            },
        },
    });
    const result = start(root, undefined);
    await fake.flush();
    await fake.emit(fake.click("ask", OWNER));

    await fake.clock.advance(TIMEOUT);
    expect(await result).toBeUndefined();
    expect(fake.lastPayload().content).toBe("root expired at 7");
    expect(order).toEqual(["child"]);
});

test("I2. a click while a modal is (silently) dismissed cancels it: the modal resolves null, the new click runs, one answer each", async () => {
    fake.modalResult = () => new Promise<ModalResult>(() => {});
    const seen: unknown[] = [];
    const view = defineView<{ page: number }, void>({
        name: "test.form",
        initial: () => ({ page: 1 }),
        render: (s, kit) => ({ content: `page ${s.page}`, components: [kit.row(kit.button("fill", label), kit.button("back", label))] }),
        on: {
            fill: async (c) => {
                seen.push(await c.modal({ title: "t", fields: [{ key: "a", label: "a" }] }));
            },
            back: (c) => {
                c.state.page = 0;
            },
        },
    });
    void start(view, undefined);
    await fake.flush();

    const fill = fake.click("fill", OWNER);
    await fake.emit(fill);
    expect(fake.modals).toHaveLength(1);

    const back = fake.click("back", OWNER);
    await fake.emit(back);
    await fake.flush();

    expect(seen).toEqual([null]);
    expect(fake.modals[0].signal?.aborted).toBe(true);
    expect(fake.renders).toEqual([{ e: back, payload: fake.lastPayload() }]);
    expect(fake.lastPayload().content).toBe("page 0");
    expect(fake.acks).toHaveLength(0);
    expect(fake.notifies).toHaveLength(0);
});

test("I3. a modal can't answer a modal submit: c.modal() throws, the submit is answered once (notify)", async () => {
    const ack = fake.modalSubmit(OWNER);
    fake.modalResult = async () => ({ values: { a: "bad" }, ack });
    const view = defineView<null, void>({
        name: "test.remodal",
        initial: () => null,
        render: (_s, kit) => ({ content: "form", components: [kit.row(kit.button("fill", label))] }),
        on: {
            fill: async (c) => {
                const spec = { title: "t", fields: [{ key: "a", label: "a" }] };
                if (await c.modal(spec)) await c.modal(spec);
            },
        },
    });
    void start(view, undefined);
    await fake.flush();

    await fake.emit(fake.click("fill", OWNER));
    expect(fake.modals).toHaveLength(1);
    expect(logError).toHaveBeenCalledTimes(1);
    const logged = (logError.mock.calls[0] as unknown[])[0];
    expect(logged instanceof Error ? logged.message : String(logged)).toMatch(/modal must be shown in response to a component interaction/);
    expect(fake.notifies.map((n) => n.e)).toEqual([ack]);
    expect(fake.acks).toHaveLength(0);
});

test("I4. two quick typed replies with a slow delete: onText runs once, the second is dropped", async () => {
    const gate = deferred();
    const deleteText = fake.deleteText;
    fake.deleteText = async (e) => {
        await gate.promise;
        await deleteText(e);
    };
    let runs = 0;
    const view = defineView<{ name: string }, void>({
        name: "test.text",
        initial: () => ({ name: "-" }),
        render: (s) => ({ content: `name=${s.name}`, acceptText: true }),
        onText: (c) => {
            runs++;
            c.state.name = c.text;
        },
        deleteTextInput: true,
    });
    void start(view, undefined);
    await fake.flush();

    await fake.emit(fake.text(OWNER, "a"));
    await fake.emit(fake.text(OWNER, "b"));
    gate.resolve();
    await fake.flush();

    expect(runs).toBe(1);
    expect(fake.lastPayload().content).toBe("name=a");
    expect(fake.deletedTexts.map((t) => t.content)).toEqual(["a"]);
});

test("M1. strip / disable / done keep Link buttons (they have no customId and still work)", async () => {
    const link = () => new ButtonBuilder().setStyle(ButtonStyle.Link).setURL("https://example.com").setLabel("docs");
    const view = defineView<null, void>({
        name: "test.link",
        initial: () => null,
        render: (_s, kit) => ({
            flags: MessageFlags.IsComponentsV2,
            components: [
                new ContainerBuilder()
                    .addSectionComponents(new SectionBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent("s")).setButtonAccessory(link()))
                    .addActionRowComponents(kit.row(kit.button("a", label), link())),
            ],
        }),
        timeoutMs: TIMEOUT,
        on: { a: (c) => c.done() },
    });
    const links = (payload: { components?: unknown }) => JSON.stringify(payload.components).match(/https:\/\/example\.com/g)?.length ?? 0;

    void start(view, undefined);
    await fake.flush();
    await fake.clock.advance(TIMEOUT);
    expect(links(fake.lastPayload())).toBe(2);
    expect(customIds(fake.lastPayload())).toEqual([]);

    fake = createFakeTransport();
    void start(defineView({ ...view, onExpire: "disable" }), undefined);
    await fake.flush();
    await fake.clock.advance(TIMEOUT);
    const json = JSON.stringify(fake.lastPayload().components);
    expect(links(fake.lastPayload())).toBe(2);
    expect(json.match(/"disabled":true/g)).toHaveLength(1);

    fake = createFakeTransport();
    void start(view, undefined);
    await fake.flush();
    await fake.emit(fake.click("a", OWNER));
    expect(links(fake.lastPayload())).toBe(2);
    expect(customIds(fake.lastPayload())).toEqual([]);
});

test("M2. expiry skips beforeExpire for an instance whose handler is still running", async () => {
    const gate = deferred();
    const applied: string[] = [];
    const view = defineView<null, void>({
        name: "test.reroll",
        initial: () => null,
        render: (_s, kit) => ({ content: "reroll", components: [kit.row(kit.button("apply", label))] }),
        timeoutMs: TIMEOUT,
        beforeExpire: async () => void applied.push("auto"),
        on: {
            apply: async () => {
                await gate.promise;
                applied.push("manual");
            },
        },
    });
    const result = start(view, undefined);
    await fake.flush();
    await fake.emit(fake.click("apply", OWNER));
    await fake.clock.advance(TIMEOUT);
    gate.resolve();
    expect(await result).toBeUndefined();
    await fake.flush();
    expect(applied).toEqual(["manual"]);
});

test("C1. start: a child whose start finishes at once shows nothing - the root's start goes on and its render is the first send", async () => {
    const instant = defineView<null, string>({
        name: "test.instant",
        initial: () => null,
        render: () => ({ content: "instant" }),
        start: (c) => c.done("skip"),
    });
    const flow = defineView<{ got: string | undefined }, void>({
        name: "test.flow",
        initial: () => ({ got: undefined }),
        render: (s) => ({ content: `flow ${s.got ?? "-"}` }),
        start: async (c) => {
            c.state.got = await c.open(instant, null);
        },
    });
    const result = start(flow, undefined);
    await fake.flush();
    expect(fake.responded.map((p) => p.content)).toEqual(["flow skip"]);
    expect(fake.renders).toHaveLength(0);
    await fake.flush();
    let settled = false;
    void result.then(
        () => (settled = true),
        () => (settled = true),
    );
    await fake.flush();
    expect(settled).toBe(false);
});

test("M2. expiry still runs beforeExpire for an instance that is only waiting (on an open child, or a modal)", async () => {
    const order: string[] = [];
    const root = defineView<null, void>({
        name: "test.reroll",
        initial: () => null,
        render: (_s, kit) => ({ content: "reroll", components: [kit.row(kit.button("ask", label))] }),
        timeoutMs: TIMEOUT,
        beforeExpire: async () => void order.push("root"),
        on: {
            ask: async (c) => {
                await c.open(step, null);
            },
        },
    });
    const result = start(root, undefined);
    await fake.flush();
    await fake.emit(fake.click("ask", OWNER));
    await fake.clock.advance(TIMEOUT);
    expect(await result).toBeUndefined();
    expect(order).toEqual(["root"]);

    fake = createFakeTransport();
    fake.modalResult = () => new Promise<ModalResult>(() => {});
    const seen: string[] = [];
    const result2 = start(defineView({ ...renamer(TIMEOUT), beforeExpire: async () => void seen.push("renamer") }), undefined);
    await fake.flush();
    await fake.emit(fake.click("rename", OWNER));
    await fake.clock.advance(10 * 60_000);
    expect(await result2).toBeUndefined();
    expect(seen).toEqual(["renamer"]);
});
