import { ActionRowBuilder, type ButtonBuilder, ButtonStyle } from "discord.js";
import { defineView, type RenderKit, type ViewDefinition, type ViewPayload } from "./view";

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

/** [<<] [<] [n / N] [>] [>>] - `<<`/`>>` disable at the edges, the middle button opens the jump modal. */
function paginationRow(kit: RenderKit, page: number, pages: number): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        kit.button("first", (b) => b.setLabel("<<").setDisabled(page === 0)),
        kit.button("prev", (b) => b.setLabel("<")),
        kit.button("jump", (b) => b.setLabel(`${page + 1} / ${pages}`).setStyle(ButtonStyle.Primary)),
        kit.button("next", (b) => b.setLabel(">")),
        kit.button("last", (b) => b.setLabel(">>").setDisabled(page === pages - 1)),
    );
}

/**
 * Numbered pages on one message: `<<` `<` `[n / N]` `>` `>>` (same look as the old
 * `utils/pagination`). `<`/`>` wrap around (first page + `<` goes to the last); `<<`/`>>` jump to
 * the ends and are disabled there; the middle button opens a "Jump to page" modal (an invalid
 * number answers "Enter a number between 1 and N." and stays). With one page it's just the page
 * (no row); it closes by idle expiry (the content stays, the row goes).
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
        on: {
            first: () => ({ page: 0 }),
            prev: ({ state }) => ({ page: state.page > 0 ? state.page - 1 : pages - 1 }),
            next: ({ state }) => ({ page: state.page < pages - 1 ? state.page + 1 : 0 }),
            last: () => ({ page: pages - 1 }),
            jump: async (c) => {
                const values = await c.modal({
                    title: "Jump to page",
                    fields: [{ key: "page", label: `Page (1-${pages})`, placeholder: `1-${pages}`, required: true, maxLength: String(pages).length }],
                });
                if (!values) return;
                const target = Number(values.page);
                if (!Number.isInteger(target) || target < 1 || target > pages) {
                    await c.notify(`Enter a number between 1 and ${pages}.`);
                    return;
                }
                return { page: target - 1 };
            },
        },
    });
}
