import { ActionRowBuilder, type ButtonBuilder, ButtonStyle } from "discord.js";
import { EmbedFormatter } from "@/utils/format";
import { Logger } from "@/utils/logging";
import { config } from "../../config";
import { describeCommandError } from "../command/user-facing-error";
import { defineView, type HandlerContext, type RenderKit, type ViewDefinition, type ViewPayload } from "./view";

const logger = new Logger("core.view.flow");

/** How a flow step ends: `ok` (next step), `skip` (next step, nothing saved), `back` (previous step), `cancel` (ends the flow). */
export type StepResult = { kind: "ok" } | { kind: "skip" } | { kind: "back" } | { kind: "cancel" };

/** A step: any View taking the flow's context as input and ending with a StepResult (its state type is its own). */
// biome-ignore lint/suspicious/noExplicitAny: each step has its own state type; the flow only sees input and result.
export type FlowStep<C> = ViewDefinition<any, StepResult, C>;

export interface FlowOptions<C> {
    /** `<cog>.<name>` of the View. */
    name: string;
    /** Handed to every step as its `input` (and to `onFinish`) - steps may mutate it to pass data along. */
    context: C;
    /** In order. A step is re-created (its `initial` runs again) each time the flow enters it. */
    steps: FlowStep<C>[];
    /** The final screen after the last step (a summary). A throw is logged and shown as an error. */
    onFinish: (ctx: C) => Promise<ViewPayload>;
    /** The final screen on Cancel. Default EmbedFormatter.info("Cancelled."). */
    onCancel?: ViewPayload;
    /** The final screen on idle expiry, in any step. Default `onCancel`. */
    onTimeout?: ViewPayload;
    /** Idle timeout of the whole flow (renewed by every interaction, in any step or sub-screen). Default config.ui.flowStepTimeoutMs. */
    stepTimeoutMs?: number;
}

export interface FlowState {
    /** The step on screen (0-based). */
    index: number;
    /** Set once the flow ended: its final screen. */
    final?: ViewPayload;
}

/**
 * Steps in sequence on the same message: step 1 shows at once, and each step is a View (opened as
 * a child with the flow's `context` as input) that ends with a StepResult - `ok`/`skip` go to the
 * next step, `back` to the previous one (on the first step it stays), `cancel` ends with
 * `onCancel`. After the last step `onFinish`'s payload is the final screen. The flow owns the
 * session's clock: an idle `stepTimeoutMs` in any step (or a step's own sub-screen/confirm) ends it
 * with `onTimeout`. Resolves "finished" / "cancelled", or `undefined` on expiry.
 * Build step screens with `navRow` and spread `navHandlers()` into their `on`.
 *
 * @example
 * const welcome = defineView<Setup, StepResult, Setup>({
 *     name: "biomehunt.ez-welcome",
 *     initial: (ctx) => ctx,
 *     render: (_s, kit) => ({ ...EmbedFormatter.info("Welcome!"), components: [navRow(kit, { canBack: false, skipLabel: "Start" })] }),
 *     on: { ...navHandlers() },
 * });
 * await ctx.open(flow({ name: "biomehunt.ez-setup", context: setup, steps: [welcome, roles], onFinish: async (s) => summary(s) }), undefined);
 */
export function flow<C>(opts: FlowOptions<C>): ViewDefinition<FlowState, "finished" | "cancelled", void> {
    const cancelled = opts.onCancel ?? EmbedFormatter.info("Cancelled.");
    const timedOut = opts.onTimeout ?? cancelled;
    return defineView<FlowState, "finished" | "cancelled", void>({
        name: opts.name,
        initial: () => ({ index: 0 }),
        timeoutMs: opts.stepTimeoutMs ?? config.ui.flowStepTimeoutMs,
        onExpire: () => timedOut,
        // Only seen on the final screen (or if a step ends without painting anything, briefly).
        render: (state) => state.final ?? EmbedFormatter.info("Loading..."),
        start: async (c) => {
            let index = 0;
            while (index < opts.steps.length) {
                c.state.index = index;
                const result = await c.open(opts.steps[index], opts.context);
                if (result === undefined) return; // expired: the session already shows onTimeout
                if (result.kind === "cancel") {
                    c.state.final = cancelled;
                    c.done("cancelled");
                    return;
                }
                index = result.kind === "back" ? Math.max(0, index - 1) : index + 1;
            }
            c.state.final = await finishPayload(opts);
            c.done("finished");
        },
    });
}

async function finishPayload<C>(opts: FlowOptions<C>): Promise<ViewPayload> {
    try {
        return await opts.onFinish(opts.context);
    } catch (err) {
        const described = describeCommandError(err);
        if (described.kind === "user") return EmbedFormatter.error(described.message);
        logger.error(err instanceof Error ? err : new Error(String(err)), { view: opts.name });
        return EmbedFormatter.error("Error running the action!");
    }
}

export interface NavRowOptions {
    /** Back is always shown, disabled when false (the first step). */
    canBack: boolean;
    /** The Skip button's label (e.g. "Done", "Start"). Default "Skip"; `false` hides it. */
    skipLabel?: string | false;
    /** Buttons placed between Back and Skip (e.g. "Fill Form"). At most 2 with Skip (5 per row). */
    extra?: ButtonBuilder[];
}

/**
 * A flow step's navigation row: [Back] [...extra] [Skip] [Cancel], bound to the keys "back",
 * "skip" and "cancel" - handle them with `navHandlers()`.
 *
 * @example
 * render: (s, kit) => ({ ...body(s), components: [navRow(kit, { canBack: true, extra: [kit.button("fill", (b) => b.setLabel("Fill Form"))] })] })
 */
export function navRow(kit: RenderKit, opts: NavRowOptions): ActionRowBuilder<ButtonBuilder> {
    const skipLabel = opts.skipLabel ?? "Skip";
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        kit.button("back", (b) => b.setLabel("Back").setDisabled(!opts.canBack)),
        ...(opts.extra ?? []),
        ...(skipLabel === false ? [] : [kit.button("skip", (b) => b.setLabel(skipLabel))]),
        kit.button("cancel", (b) => b.setLabel("Cancel").setStyle(ButtonStyle.Danger)),
    );
}

/**
 * The handlers for `navRow`'s keys: each ends the step with its StepResult. Spread into `on`
 * (override one to do something first, e.g. save before `skip`).
 *
 * @example
 * on: { ...navHandlers<MyState>(), fill: async (c) => { ... c.done({ kind: "ok" }); } }
 */
export function navHandlers<S>(): Record<"back" | "skip" | "cancel", (c: HandlerContext<S, StepResult>) => void> {
    return {
        back: (c) => c.done({ kind: "back" }),
        skip: (c) => c.done({ kind: "skip" }),
        cancel: (c) => c.done({ kind: "cancel" }),
    };
}
