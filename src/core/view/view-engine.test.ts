import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { type ButtonBuilder, ContainerBuilder, MessageFlags, TextDisplayBuilder } from "discord.js";
import { Logger } from "@/utils/logging";
import { UserFacingError } from "../command/user-facing-error";
import { createFakeTransport, customIds, type FakeTransport } from "./fake-transport";
import { defineView, type ViewDefinition } from "./view";
import { createViewSession } from "./view-engine";

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
    return createViewSession(fake, invokerId, fake.clock).run(view, input, fake.respond);
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
