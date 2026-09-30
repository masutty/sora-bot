import { ActionRowBuilder, type ButtonBuilder, ButtonStyle } from "discord.js";
import { defineView, type HandlerContext, type HandlerResult, type RenderKit, type ViewDefinition, type ViewPayload } from "./view";

export interface PaginateOptions {
    /** `<cog>.<name>` of the View. */
    name: string;
    /** How many pages there are (at least 1). With a single page there's no navigation row. */
    pages: number;
    /** The page's content (0-based `page`) - pure. The navigation row is appended to its `components`. */
    renderPage: (page: number) => ViewPayload;
    /** 0-based page to open on. Default 0. */
    initialPage?: number;
    /** Idle timeout when this is the root. Default config.ui.viewTimeoutMs. */
    timeoutMs?: number;
}

/**
 * The pagination row `[<<] [<] [n / N] [>] [>>]`, bound to the keys first/prev/jump/next/last -
 * handle them with `paginationHandlers`. `<<`/`>>` are disabled at the edges; the middle button
 * (Primary) opens the jump modal. For a custom paginated View (a list you pick from, with its own
 * buttons or typed input); `paginate` is built from the same two pieces.
 *
 * @example
 * render: (s, kit) => ({ ...list(s.page), components: [paginationRow(kit, s.page, pages), kit.row(kit.button("back", (b) => b.setLabel("Back")))] })
 */
export function paginationRow(kit: RenderKit, page: number, pages: number): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        kit.button("first", (b) => b.setLabel("<<").setDisabled(page === 0)),
        kit.button("prev", (b) => b.setLabel("<")),
        kit.button("jump", (b) => b.setLabel(`${page + 1} / ${pages}`).setStyle(ButtonStyle.Primary)),
        kit.button("next", (b) => b.setLabel(">")),
        kit.button("last", (b) => b.setLabel(">>").setDisabled(page === pages - 1)),
    );
}

export interface PaginationHandlersOptions<S> {
    /** Page count - a number, or read from the state when it changes (e.g. a list items are removed from). */
    pages: number | ((state: S) => number);
}

/**
 * The handlers for `paginationRow`'s keys on a state with a `page` field (0-based): `<`/`>` wrap
 * around, `<<`/`>>` go to the ends, the jump modal ("Jump to page") takes a 1-based number and
 * answers an invalid one with "Enter a number between 1 and N." (the page stays). Spread into `on`.
 *
 * @example
 * on: { ...paginationHandlers({ pages: (s) => Math.ceil(s.items.length / 10) }), back: (c) => c.done(null) }
 */
export function paginationHandlers<S extends { page: number }, R = void>(
    opts: PaginationHandlersOptions<S>,
): Record<"first" | "prev" | "jump" | "next" | "last", (c: HandlerContext<S, R>) => HandlerResult<S>> {
    const count = (state: S) => Math.max(1, Math.floor(typeof opts.pages === "function" ? opts.pages(state) : opts.pages));
    return {
        first: (c) => {
            c.state.page = 0;
        },
        prev: (c) => {
            const pages = count(c.state);
            c.state.page = c.state.page > 0 ? Math.min(c.state.page - 1, pages - 1) : pages - 1;
        },
        next: (c) => {
            c.state.page = c.state.page < count(c.state) - 1 ? c.state.page + 1 : 0;
        },
        last: (c) => {
            c.state.page = count(c.state) - 1;
        },
        jump: async (c) => {
            const pages = count(c.state);
            const values = await c.modal({
                title: "Jump to page",
                fields: [
                    { key: "page", label: `Page (1-${pages})`, placeholder: `1-${pages}`, required: true, maxLength: String(pages).length },
                ],
            });
            if (!values) return;
            const target = Number(values.page);
            if (!Number.isInteger(target) || target < 1 || target > pages) {
                await c.notify(`Enter a number between 1 and ${pages}.`);
                return;
            }
            c.state.page = target - 1;
        },
    };
}

/**
 * Numbered pages on one message: `<<` `<` `[n / N]` `>` `>>`. `<`/`>` wrap around (first page + `<`
 * goes to the last); `<<`/`>>` jump to the ends and are disabled there; the middle button opens a
 * "Jump to page" modal (an invalid
 * number answers "Enter a number between 1 and N." and stays). With one page it's just the page
 * (no row); it closes by idle expiry (the content stays, the row goes). For a custom paginated View
 * (its own buttons, typed input, a result), compose `paginationRow` + `paginationHandlers` instead.
 *
 * @example
 * await ctx.open(paginate({
 *     name: "core.help",
 *     pages: chunks.length,
 *     renderPage: (p) => EmbedFormatter.plain(chunks[p]),
 * }), undefined);
 */
export function paginate(opts: PaginateOptions): ViewDefinition<{ page: number }, void, void> {
    const pages = Math.max(1, Math.floor(opts.pages));
    const clamp = (p: number) => Math.min(Math.max(0, Math.floor(p)), pages - 1);
    return defineView<{ page: number }, void, void>({
        name: opts.name,
        initial: () => ({ page: clamp(opts.initialPage ?? 0) }),
        timeoutMs: opts.timeoutMs,
        render: ({ page }, kit) => {
            const payload = opts.renderPage(page);
            if (pages <= 1) return payload;
            return { ...payload, components: [...(payload.components ?? []), paginationRow(kit, page, pages)] };
        },
        on: paginationHandlers({ pages }),
    });
}
