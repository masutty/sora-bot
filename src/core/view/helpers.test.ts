import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { AttachmentBuilder, ButtonStyle } from "discord.js";
import { EmbedFormatter } from "@/utils/format";
import { Logger } from "@/utils/logging";
import { config } from "../../config";
import { UserFacingError } from "../command/user-facing-error";
import { confirm } from "./confirm";
import { createFakeTransport, customIds, type FakeTransport } from "./fake-transport";
import { type FlowOptions, flow, navHandlers, navRow, type StepResult } from "./flow";
import { paginate, paginationHandlers, paginationRow } from "./paginate";
import { tabs } from "./tabs";
import { createRenderKit, defineView, type ViewDefinition, type ViewPayload } from "./view";

const OWNER = "owner";

let fake: FakeTransport;
let logError: ReturnType<typeof spyOn>;

beforeEach(() => {
    fake = createFakeTransport();
    logError = spyOn(Logger.prototype, "error").mockImplementation(() => {});
});

afterEach(() => {
    logError.mockRestore();
});

type Json = { type?: number; custom_id?: string; label?: string; style?: number; disabled?: boolean; content?: string; components?: Json[]; accessory?: Json };

/** The payload's components as plain JSON, depth-first. */
function flatten(payload: ViewPayload): Json[] {
    const out: Json[] = [];
    const walk = (node: unknown) => {
        if (node === null || typeof node !== "object") return;
        const json = typeof (node as { toJSON?: unknown }).toJSON === "function" ? (node as { toJSON(): unknown }).toJSON() : node;
        if (Array.isArray(json)) {
            for (const child of json) walk(child);
            return;
        }
        const obj = json as Json;
        out.push(obj);
        walk(obj.components);
        walk(obj.accessory);
    };
    walk(payload.components);
    return out;
}

/** The component bound to `key` on the current message, as JSON. */
function comp(key: string, payload = fake.lastPayload()): Json {
    const found = flatten(payload).find((c) => c.custom_id?.endsWith(`:${key}`));
    if (!found) throw new Error(`No component "${key}"`);
    return found;
}

/** Every text on the message (content + text displays), joined by newlines. */
function text(payload = fake.lastPayload()): string {
    return [payload.content ?? "", ...flatten(payload).map((c) => c.content ?? "")].filter(Boolean).join("\n");
}

const keys = (payload = fake.lastPayload()) => customIds(payload).map((id) => id.split(":").slice(2).join(":"));

// ─── paginate ───────────────────────────────────────────────────────────────

const threePages = () => paginate({ name: "test.pages", pages: 3, renderPage: (p) => ({ content: `page ${p}` }) });

test("paginate: << < [n/N] > >> - > on the last page wraps to 0, < on 0 wraps to the last, <</>> disable at the edges", async () => {
    void fake.run(threePages(), undefined);
    await fake.flush();

    expect(fake.responded[0].content).toBe("page 0");
    expect(keys()).toEqual(["first", "prev", "jump", "next", "last"]);
    expect(flatten(fake.lastPayload()).filter((c) => c.custom_id).map((c) => c.label)).toEqual(["<<", "<", "1 / 3", ">", ">>"]);
    expect(comp("jump").style).toBe(ButtonStyle.Primary);
    expect(comp("first").disabled).toBe(true);
    expect(comp("last").disabled).toBeFalsy();

    await fake.emit(fake.click("last", OWNER));
    expect(fake.lastPayload().content).toBe("page 2");
    expect(comp("last").disabled).toBe(true);
    expect(comp("first").disabled).toBeFalsy();
    expect(comp("jump").label).toBe("3 / 3");

    await fake.emit(fake.click("next", OWNER));
    expect(fake.lastPayload().content).toBe("page 0");

    await fake.emit(fake.click("prev", OWNER));
    expect(fake.lastPayload().content).toBe("page 2");

    await fake.emit(fake.click("first", OWNER));
    expect(fake.lastPayload().content).toBe("page 0");
    await fake.emit(fake.click("next", OWNER));
    expect(fake.lastPayload().content).toBe("page 1");
});

test("paginate: the jump modal with \"3\" goes to page index 2; an invalid value notifies and stays", async () => {
    void fake.run(threePages(), undefined);
    await fake.flush();

    const ack = fake.modalSubmit(OWNER);
    fake.modalResult = async () => ({ values: { page: "3" }, ack });
    await fake.emit(fake.click("jump", OWNER));
    expect(fake.modals[0].spec.title).toBe("Jump to page");
    expect(fake.modals[0].spec.fields[0]).toMatchObject({ key: "page", label: "Page (1-3)", placeholder: "1-3", maxLength: 1 });
    expect(fake.lastPayload().content).toBe("page 2");
    expect(fake.renders.at(-1)?.e).toBe(ack);

    for (const bad of ["9", "0", "abc", "1.5"]) {
        const badAck = fake.modalSubmit(OWNER);
        fake.modalResult = async () => ({ values: { page: bad }, ack: badAck });
        await fake.emit(fake.click("jump", OWNER));
        expect(fake.notifies.at(-1)).toEqual({ e: badAck, content: "Enter a number between 1 and 3." });
        expect(fake.lastPayload().content).toBe("page 2");
    }
});

test("paginate: initialPage is where it opens; a single page has no navigation row", async () => {
    void fake.run(paginate({ name: "test.pages", pages: 3, initialPage: 1, renderPage: (p) => ({ content: `page ${p}` }) }), undefined);
    await fake.flush();
    expect(fake.lastPayload().content).toBe("page 1");

    fake = createFakeTransport();
    void fake.run(paginate({ name: "test.pages", pages: 1, renderPage: (p) => ({ content: `page ${p}` }) }), undefined);
    await fake.flush();
    expect(fake.lastPayload().content).toBe("page 0");
    expect(customIds(fake.lastPayload())).toEqual([]);
});

test("paginationRow + paginationHandlers compose a custom view: pages, its own Back, a typed pick with retry, done(result)", async () => {
    const items = ["a", "b", "c", "d", "e"];
    const PER_PAGE = 2;
    const pagesOf = () => Math.ceil(items.length / PER_PAGE);
    const remover = defineView<{ page: number }, string | null, void>({
        name: "test.remove",
        initial: () => ({ page: 0 }),
        render: ({ page }, kit) => ({
            content: items
                .slice(page * PER_PAGE, (page + 1) * PER_PAGE)
                .map((it, i) => `${page * PER_PAGE + i + 1}. ${it}`)
                .join("\n"),
            components: [paginationRow(kit, page, pagesOf()), kit.row(kit.button("back", (b) => b.setLabel("Back")))],
            acceptText: true,
        }),
        on: {
            ...paginationHandlers({ pages: pagesOf }),
            back: (c) => c.done(null),
        },
        onText: async (c) => {
            const n = Number(c.text);
            if (!Number.isInteger(n) || n < 1 || n > items.length) {
                await c.notify("Invalid number, try again.");
                return;
            }
            c.done(items[n - 1]);
        },
    });
    const result = fake.run(remover, undefined);
    await fake.flush();

    expect(fake.lastPayload().content).toBe("1. a\n2. b");
    expect(keys()).toEqual(["first", "prev", "jump", "next", "last", "back"]);
    expect(comp("jump").label).toBe("1 / 3");
    expect(comp("first").disabled).toBe(true);

    await fake.emit(fake.click("prev", OWNER));
    expect(fake.lastPayload().content).toBe("5. e");
    await fake.emit(fake.click("next", OWNER));
    expect(fake.lastPayload().content).toBe("1. a\n2. b");

    const ack = fake.modalSubmit(OWNER);
    fake.modalResult = async () => ({ values: { page: "2" }, ack });
    await fake.emit(fake.click("jump", OWNER));
    expect(fake.lastPayload().content).toBe("3. c\n4. d");
    const badAck = fake.modalSubmit(OWNER);
    fake.modalResult = async () => ({ values: { page: "7" }, ack: badAck });
    await fake.emit(fake.click("jump", OWNER));
    expect(fake.notifies.at(-1)).toEqual({ e: badAck, content: "Enter a number between 1 and 3." });

    expect(fake.textListening).toBe(true);
    await fake.emit(fake.text(OWNER, "9"));
    expect(fake.notifies.at(-1)?.content).toBe("Invalid number, try again.");
    await fake.emit(fake.text(OWNER, "4"));
    expect(await result).toBe("d");
});

test("paginationHandlers: Back from the custom view dones with its own result", async () => {
    const view = defineView<{ page: number; tag: string }, string, void>({
        name: "test.pv",
        initial: () => ({ page: 0, tag: "x" }),
        render: (s, kit) => ({ content: `p${s.page}`, components: [paginationRow(kit, s.page, 2), kit.row(kit.button("back", (b) => b.setLabel("Back")))] }),
        on: { ...paginationHandlers({ pages: 2 }), back: (c) => c.done(`back from ${c.state.page} ${c.state.tag}`) },
    });
    const result = fake.run(view, undefined);
    await fake.flush();
    await fake.emit(fake.click("last", OWNER));
    expect(fake.lastPayload().content).toBe("p1");
    await fake.emit(fake.click("back", OWNER));
    expect(await result).toBe("back from 1 x");
});

// ─── tabs ───────────────────────────────────────────────────────────────────

test("tabs: clicking tab \"b\" renders tab b with its button disabled (and Primary); a tab's extra rows have their own handlers", async () => {
    const view = tabs({
        name: "test.tabs",
        initial: (n: number) => ({ tab: "a", n }),
        tabs: [
            { key: "a", label: "A" },
            { key: "b", label: "B", emoji: "🌸" },
        ],
        renderTab: (s, kit) => ({
            payload: EmbedFormatter.plain(`tab ${s.tab} n=${s.n}`),
            extraRows: s.tab === "b" ? [kit.row(kit.button("inc", (b) => b.setLabel("+1")))] : [],
        }),
        on: {
            inc: (c) => {
                c.state.n++;
            },
        },
    });
    void fake.run(view, 5);
    await fake.flush();

    expect(text()).toBe("tab a n=5");
    expect(keys()).toEqual(["tab:a", "tab:b"]);
    expect(comp("tab:a")).toMatchObject({ disabled: true, style: ButtonStyle.Primary, label: "A" });
    expect(comp("tab:b").disabled).toBeFalsy();
    expect(comp("tab:b").style).toBe(ButtonStyle.Secondary);

    await fake.emit(fake.click("tab:b", OWNER));
    expect(text()).toBe("tab b n=5");
    expect(comp("tab:b")).toMatchObject({ disabled: true, style: ButtonStyle.Primary });
    expect(comp("tab:a").disabled).toBeFalsy();
    expect(keys()).toEqual(["tab:a", "tab:b", "inc"]);

    await fake.emit(fake.click("inc", OWNER));
    expect(text()).toBe("tab b n=6");
});

test("tabs: onTabChange runs after the switch (mutate or return a state) - e.g. resetting a page", async () => {
    const view = tabs({
        name: "test.tabs",
        initial: () => ({ tab: "a", page: 0 }),
        tabs: [
            { key: "a", label: "A" },
            { key: "b", label: "B" },
            { key: "c", label: "C" },
        ],
        renderTab: (s, kit) => ({ payload: { content: `${s.tab} p${s.page}` }, extraRows: [kit.row(kit.button("more", (b) => b.setLabel(">")))] }),
        on: {
            more: (c) => {
                c.state.page++;
            },
        },
        onTabChange: (s, key) => {
            if (key === "c") return { tab: key, page: 100 };
            s.page = 0;
        },
    });
    void fake.run(view, undefined);
    await fake.flush();

    await fake.emit(fake.click("more", OWNER));
    await fake.emit(fake.click("more", OWNER));
    expect(fake.lastPayload().content).toBe("a p2");
    await fake.emit(fake.click("tab:b", OWNER));
    expect(fake.lastPayload().content).toBe("b p0");
    await fake.emit(fake.click("tab:c", OWNER));
    expect(fake.lastPayload().content).toBe("c p100");
});

// ─── confirm ────────────────────────────────────────────────────────────────

function confirmView(onConfirm: () => Promise<ViewPayload>) {
    return confirm({
        name: "test.confirm",
        title: "Remove <@123>?",
        fields: [{ label: "User", value: "sora" }],
        onConfirm,
    });
}

test("confirm: the summary container + [Confirm][Cancel]; files are attached", async () => {
    const file = new AttachmentBuilder(Buffer.from("x"), { name: "flower.png" });
    void fake.run(
        confirm({ name: "test.confirm", title: "Go?", fields: [{ label: "A", value: "1" }], files: [file], thumbnailAttachment: "flower.png", onConfirm: async () => EmbedFormatter.success("ok") }),
        undefined,
    );
    await fake.flush();

    const sent = fake.responded[0];
    expect(text(sent)).toBe("**Go?**\n- A: `1`");
    expect(sent.files).toEqual([file]);
    expect(flatten(sent).some((c) => (c.accessory as { media?: { url?: string } } | undefined)?.media?.url === "attachment://flower.png")).toBe(true);
    expect(comp("yes", sent)).toMatchObject({ label: "Confirm", style: ButtonStyle.Success });
    expect(comp("no", sent)).toMatchObject({ label: "Cancel", style: ButtonStyle.Danger });
});

test("confirm: yes runs onConfirm, resolves true, and the final screen is onConfirm's payload", async () => {
    let runs = 0;
    const result = fake.run(
        confirmView(async () => {
            runs++;
            return EmbedFormatter.success("Removed!");
        }),
        undefined,
    );
    await fake.flush();
    expect(text()).toContain("**Remove <@123>?**");

    await fake.emit(fake.click("yes", OWNER));
    expect(await result).toBe(true);
    expect(runs).toBe(1);
    expect(text()).toContain("Removed!");
    expect(customIds(fake.lastPayload())).toEqual([]);
    expect(fake.closed).toBe(1);
});

test("confirm: an onConfirm that throws shows \"Error running the action!\" (a UserFacingError shows its own message) and resolves false", async () => {
    const result = fake.run(
        confirmView(async () => {
            throw new Error("db down");
        }),
        undefined,
    );
    await fake.flush();
    await fake.emit(fake.click("yes", OWNER));
    expect(await result).toBe(false);
    expect(text()).toContain("Error running the action!");
    expect(logError).toHaveBeenCalled();

    fake = createFakeTransport();
    const result2 = fake.run(
        confirmView(async () => {
            throw new UserFacingError("Not today.");
        }),
        undefined,
    );
    await fake.flush();
    await fake.emit(fake.click("yes", OWNER));
    expect(await result2).toBe(false);
    expect(text()).toContain("Not today.");
});

test("confirm: no resolves false and shows \"Action cancelled.\" without running onConfirm", async () => {
    let runs = 0;
    const result = fake.run(
        confirmView(async () => {
            runs++;
            return EmbedFormatter.success("x");
        }),
        undefined,
    );
    await fake.flush();
    await fake.emit(fake.click("no", OWNER));

    expect(await result).toBe(false);
    expect(runs).toBe(0);
    expect(text()).toContain("Action cancelled.");
    expect(customIds(fake.lastPayload())).toEqual([]);
});

test("confirm: expires after config.ui.confirmTimeoutMs idle -> undefined and \"Confirmation expired.\"", async () => {
    const result = fake.run(confirmView(async () => EmbedFormatter.success("x")), undefined);
    await fake.flush();

    await fake.clock.advance(config.ui.confirmTimeoutMs - 1);
    expect(fake.closed).toBe(0);
    await fake.clock.advance(1);

    expect(await result).toBeUndefined();
    expect(text()).toContain("Confirmation expired.");
    expect(customIds(fake.lastPayload())).toEqual([]);
});

// ─── flow ───────────────────────────────────────────────────────────────────

type Ctx = { log: string[] };

/** A step: shows its id, [Back][OK][Skip][Cancel]; OK records the id in the context. */
function step(id: string, extra: Partial<ViewDefinition<Ctx, StepResult, Ctx>> = {}): ViewDefinition<Ctx, StepResult, Ctx> {
    return defineView<Ctx, StepResult, Ctx>({
        name: `test.step-${id}`,
        initial: (ctx) => ctx,
        render: (_ctx, kit) => ({
            content: `step ${id}`,
            components: [navRow(kit, { canBack: id !== "1", extra: [kit.button("ok", (b) => b.setLabel("OK"))] })],
        }),
        on: {
            ...navHandlers<Ctx>(),
            ok: (c) => {
                c.state.log.push(id);
                c.done({ kind: "ok" });
            },
        },
        ...extra,
    });
}

function twoStepFlow(ctx: Ctx, extra: Partial<FlowOptions<Ctx>> = {}) {
    return flow<Ctx>({
        name: "test.flow",
        context: ctx,
        steps: [step("1"), step("2")],
        onFinish: async (c) => EmbedFormatter.success(`done: ${c.log.join(",")}`),
        ...extra,
    });
}

test("flow: step 1 is shown at once (no click); ok, ok -> onFinish is the final screen and it resolves \"finished\"", async () => {
    const ctx: Ctx = { log: [] };
    const result = fake.run(twoStepFlow(ctx), undefined);
    await fake.flush();

    expect(fake.responded).toHaveLength(1);
    expect(fake.responded[0].content).toBe("step 1");
    expect(fake.renders).toHaveLength(0);

    await fake.emit(fake.click("ok", OWNER));
    expect(fake.lastPayload().content).toBe("step 2");

    const last = fake.click("ok", OWNER);
    await fake.emit(last);
    expect(await result).toBe("finished");
    expect(text()).toContain("done: 1,2");
    expect(customIds(fake.lastPayload())).toEqual([]);
    // Every click answered exactly once, by a render.
    expect(fake.renders.filter((r) => r.e === last)).toHaveLength(1);
    expect(fake.acks).toHaveLength(0);
    expect(fake.closed).toBe(1);
});

test("flow: back on step 2 returns to step 1; skip advances without running the step's action", async () => {
    const ctx: Ctx = { log: [] };
    const result = fake.run(twoStepFlow(ctx), undefined);
    await fake.flush();

    await fake.emit(fake.click("ok", OWNER));
    expect(fake.lastPayload().content).toBe("step 2");
    await fake.emit(fake.click("back", OWNER));
    expect(fake.lastPayload().content).toBe("step 1");
    expect(comp("back").disabled).toBe(true);

    await fake.emit(fake.click("skip", OWNER));
    expect(fake.lastPayload().content).toBe("step 2");
    await fake.emit(fake.click("ok", OWNER));

    expect(await result).toBe("finished");
    expect(ctx.log).toEqual(["1", "2"]);
    expect(text()).toContain("done: 1,2");
});

test("flow: cancel renders onCancel and resolves \"cancelled\" (default \"Cancelled.\")", async () => {
    const result = fake.run(twoStepFlow({ log: [] }, { onCancel: EmbedFormatter.info("Setup cancelled.") }), undefined);
    await fake.flush();
    await fake.emit(fake.click("ok", OWNER));
    await fake.emit(fake.click("cancel", OWNER));

    expect(await result).toBe("cancelled");
    expect(text()).toContain("Setup cancelled.");
    expect(customIds(fake.lastPayload())).toEqual([]);

    fake = createFakeTransport();
    const result2 = fake.run(twoStepFlow({ log: [] }), undefined);
    await fake.flush();
    await fake.emit(fake.click("cancel", OWNER));
    expect(await result2).toBe("cancelled");
    expect(text()).toContain("Cancelled.");
});

test("flow: an idle timeout in any step finalizes the message (onTimeout, default onCancel) and resolves undefined", async () => {
    const ctx: Ctx = { log: [] };
    const result = fake.run(twoStepFlow(ctx, { onTimeout: EmbedFormatter.warn("Setup timed out.") }), undefined);
    await fake.flush();
    await fake.emit(fake.click("ok", OWNER));

    await fake.clock.advance(config.ui.flowStepTimeoutMs - 1);
    await fake.emit(fake.click("back", OWNER)); // activity renews the clock
    expect(fake.lastPayload().content).toBe("step 1");
    await fake.clock.advance(config.ui.flowStepTimeoutMs - 1);
    expect(fake.closed).toBe(0);
    await fake.clock.advance(1);

    expect(await result).toBeUndefined();
    expect(text()).toContain("Setup timed out.");
    expect(customIds(fake.lastPayload())).toEqual([]);
    expect(fake.closed).toBe(1);

    fake = createFakeTransport();
    const result2 = fake.run(twoStepFlow({ log: [] }, { stepTimeoutMs: 500, onCancel: EmbedFormatter.info("Setup cancelled.") }), undefined);
    await fake.flush();
    await fake.clock.advance(500);
    expect(await result2).toBeUndefined();
    expect(text()).toContain("Setup cancelled.");
});

test("flow: a child opened inside a step inherits the flow's clock (its own timeoutMs/onExpire don't apply)", async () => {
    const child = defineView<null, string>({
        name: "test.sub",
        initial: () => null,
        render: (_s, kit) => ({ content: "sub", components: [kit.row(kit.button("pick", (b) => b.setLabel("pick")))] }),
        on: { pick: (c) => c.done("picked") },
        timeoutMs: 10,
        onExpire: () => ({ content: "child expired" }),
    });
    const withSub = step("1", {
        on: {
            ...navHandlers<Ctx>(),
            ok: async (c) => {
                const got = await c.open(child, null);
                if (got === undefined) return;
                c.state.log.push(got);
                c.done({ kind: "ok" });
            },
        },
    });
    const result = fake.run(
        flow<Ctx>({ name: "test.flow", context: { log: [] }, steps: [withSub], onFinish: async (c) => ({ content: `fin ${c.log}` }), stepTimeoutMs: 1_000, onTimeout: { content: "flow timed out" } }),
        undefined,
    );
    await fake.flush();
    await fake.emit(fake.click("ok", OWNER));
    expect(fake.lastPayload().content).toBe("sub");

    await fake.clock.advance(999);
    expect(fake.closed).toBe(0);
    await fake.clock.advance(1);

    expect(await result).toBeUndefined();
    expect(fake.lastPayload().content).toBe("flow timed out");
});

test("flow: a reused multi-screen View as a step (stepBiomeForwards-like) - its StepResult drives the navigation", async () => {
    // A list view with its own child ("create") and redraws, ending the step with whatever exit the user picks.
    const create = defineView<null, string>({
        name: "test.fwd-create",
        initial: () => null,
        render: (_s, kit) => ({ content: "create", components: [kit.row(kit.button("save", (b) => b.setLabel("save")))] }),
        on: { save: (c) => c.done("fwd") },
    });
    const forwards = defineView<{ ctx: Ctx; items: string[] }, StepResult, Ctx>({
        name: "test.fwd-list",
        initial: (ctx) => ({ ctx, items: [] }),
        render: (s, kit) => ({
            content: `forwards [${s.items.join(",")}]`,
            components: [kit.row(kit.button("create", (b) => b.setLabel("Create"))), navRow(kit, { canBack: true, skipLabel: "Done" })],
        }),
        on: {
            ...navHandlers(),
            create: async (c) => {
                const item = await c.open(create, null);
                if (item) c.state.items.push(item);
            },
        },
    });
    const ctx: Ctx = { log: [] };
    const result = fake.run(
        flow<Ctx>({ name: "test.flow", context: ctx, steps: [step("1"), forwards], onFinish: async (c) => ({ content: `fin ${c.log}` }) }),
        undefined,
    );
    await fake.flush();

    await fake.emit(fake.click("ok", OWNER));
    expect(fake.lastPayload().content).toBe("forwards []");
    expect(comp("skip").label).toBe("Done");
    await fake.emit(fake.click("create", OWNER));
    expect(fake.lastPayload().content).toBe("create");
    await fake.emit(fake.click("save", OWNER));
    expect(fake.lastPayload().content).toBe("forwards [fwd]");

    await fake.emit(fake.click("back", OWNER));
    expect(fake.lastPayload().content).toBe("step 1");
    await fake.emit(fake.click("ok", OWNER));
    // Re-entered: a fresh instance of the step (its initial runs again).
    expect(fake.lastPayload().content).toBe("forwards []");
    await fake.emit(fake.click("skip", OWNER));

    expect(await result).toBe("finished");
    expect(fake.lastPayload().content).toBe("fin 1,1");
});

test("navRow: [Back][...extra][Skip][Cancel]; Back disabled when it can't go back; skipLabel false hides Skip", async () => {
    const view = defineView<boolean, void, boolean>({
        name: "test.nav",
        initial: (second) => second,
        render: (second, kit) => ({
            components: [
                second
                    ? navRow(kit, { canBack: true, skipLabel: false })
                    : navRow(kit, { canBack: false, extra: [kit.button("fill", (b) => b.setLabel("Fill Form").setStyle(ButtonStyle.Primary))] }),
            ],
        }),
    });
    const buttons = () =>
        flatten(fake.lastPayload())
            .filter((c) => c.custom_id)
            .map((b) => ({ key: b.custom_id?.split(":").slice(2).join(":"), label: b.label, style: b.style, disabled: b.disabled ?? false }));

    void fake.run(view, false);
    await fake.flush();
    expect(buttons()).toEqual([
        { key: "back", label: "Back", style: ButtonStyle.Secondary, disabled: true },
        { key: "fill", label: "Fill Form", style: ButtonStyle.Primary, disabled: false },
        { key: "skip", label: "Skip", style: ButtonStyle.Secondary, disabled: false },
        { key: "cancel", label: "Cancel", style: ButtonStyle.Danger, disabled: false },
    ]);

    fake = createFakeTransport();
    void fake.run(view, true);
    await fake.flush();
    expect(buttons().map((b) => [b.key, b.disabled])).toEqual([
        ["back", false],
        ["cancel", false],
    ]);
});

test("navRow: more than 5 buttons throws a clear error at render time", () => {
    const kit = createRenderKit("test.nav", "i");
    const b = (k: string) => kit.button(k, (x) => x.setLabel(k));
    expect(() => navRow(kit, { canBack: true, extra: [b("x1"), b("x2")] })).not.toThrow();
    expect(() => navRow(kit, { canBack: true, extra: [b("x1"), b("x2"), b("x3")] })).toThrow(/test\.nav.*6 buttons.*max is 5/);
    expect(() => navRow(kit, { canBack: true, skipLabel: false, extra: [b("x1"), b("x2"), b("x3")] })).not.toThrow();
});
