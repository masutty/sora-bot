import { expect, test } from "bun:test";
import type { ButtonBuilder, Message, User } from "discord.js";
import { createFakeTransport } from "./fake-transport";
import { runView } from "./run-view";
import { defineView } from "./view";

const OWNER = "owner";
const label = (b: ButtonBuilder) => b.setLabel("x");

const picker = defineView<{ n: number }, number, number>({
    name: "test.picker",
    initial: (n) => ({ n }),
    render: (s, kit) => ({ content: `n=${s.n}`, components: [kit.row(kit.button("finish", label))] }),
    on: { finish: (c) => c.done(c.state.n) },
});

test("runView sends the first render once through respond, binds the transport to the sent message and resolves with done", async () => {
    const fake = createFakeTransport();
    const sent = { id: "msg1" } as unknown as Message;
    const responded: unknown[] = [];
    const boundTo: Message[] = [];

    const result = runView(picker, 7, {
        respond: async (payload) => {
            responded.push(payload);
            return sent;
        },
        invoker: { id: OWNER } as User,
        transportFactory: (message) => {
            boundTo.push(message);
            return fake;
        },
    });
    await fake.flush();

    expect(responded).toHaveLength(1);
    expect((responded[0] as { content: string }).content).toBe("n=7");
    expect(boundTo).toEqual([sent]);

    // The first render went through `respond`, so the fake's own log starts empty - the click is the first transport call.
    fake.responded.push(responded[0] as never);
    await fake.emit(fake.click("finish", OWNER));

    expect(await result).toBe(7);
    expect(responded).toHaveLength(1);
    expect(fake.renders).toHaveLength(1);
    expect(fake.closed).toBe(1);
});

test("the module-author test seam: createFakeViewTransport from @/define runs a view on its manual clock", async () => {
    const { createFakeViewTransport } = await import("@/define");
    const fake = createFakeViewTransport();
    const result = fake.run(defineView({ ...picker, timeoutMs: 1_000 }), 3, OWNER);
    await fake.flush();
    expect(fake.lastPayload().content).toBe("n=3");
    await fake.clock.advance(1_000);
    expect(await result).toBeUndefined();
});

test("a View opened inside an invocation trace logs its clicks under that invocation, one step per click", async () => {
    const { currentTrace, runWithTrace } = await import("@/utils/trace");
    const fake = createFakeTransport();
    const seen: Array<string | undefined> = [];
    const counter = defineView<{ n: number }, void, void>({
        name: "test.counter",
        initial: () => ({ n: 0 }),
        render: (s, kit) => ({ content: `n=${s.n}`, components: [kit.row(kit.button("inc", label))] }),
        on: {
            inc: (c) => {
                const t = currentTrace();
                seen.push(t ? `${t.ref}.${t.step}` : undefined);
                c.state.n++;
            },
        },
    });

    // The command runs inside its trace; the View outlives the command, and its clicks arrive from
    // the gateway (outside any context) - runView must re-enter the invocation's trace for them.
    runWithTrace({ ref: "inv00001" }, () => {
        void runView(counter, undefined, {
            respond: async (payload) => {
                fake.responded.push(payload as never);
                return { id: "m" } as unknown as Message;
            },
            invoker: { id: OWNER } as User,
            transportFactory: () => fake,
        });
    });
    await fake.flush();
    await fake.emit(fake.click("inc", OWNER));
    await fake.emit(fake.click("inc", OWNER));

    expect(seen).toEqual(["inv00001.1:inc", "inv00001.2:inc"]);
});
