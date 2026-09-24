import {
    ActionRowBuilder,
    type ButtonInteraction,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
    LabelBuilder,
    type Message,
    type MessageEditOptions,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
} from "discord.js";
import { NO_PINGS } from "./format";

const FIRST_ID = "pg-first";
const PREV_ID = "pg-prev";
const JUMP_ID = "pg-jump";
const NEXT_ID = "pg-next";
const LAST_ID = "pg-last";
const JUMP_INPUT_ID = "page";

/**
 * Row [«] [‹] [current page] [›] [»] - 5 buttons, the max per ActionRow (if this ever needs one
 * more, there's no room left - it'd need a second row). The middle button shows the page (instead
 * of a footer) and, clicked, opens a modal to type the page number directly (the closest thing to
 * a persistent "number field" in a button row - Discord has no such input outside a modal).
 * «/» jump straight to the first/last page and DISABLE at the matching edge; ‹/› (single step)
 * keep wraparound (first page + ‹ goes to the last, and vice-versa).
 */
export function buildPaginationRow(page: number, pages: number): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(FIRST_ID).setLabel("<<").setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
        new ButtonBuilder().setCustomId(PREV_ID).setLabel("<").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(JUMP_ID).setLabel(`${page + 1} / ${pages}`).setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(NEXT_ID).setLabel(">").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(LAST_ID).setLabel(">>").setStyle(ButtonStyle.Secondary).setDisabled(page === pages - 1),
    );
}

function buildJumpModal(pages: number): ModalBuilder {
    const input = new TextInputBuilder()
        .setCustomId(JUMP_INPUT_ID)
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder(`1-${pages}`)
        .setMaxLength(String(pages).length);
    return new ModalBuilder()
        .setCustomId(`${JUMP_ID}:${Date.now()}`)
        .setTitle("Jump to page")
        .addComponents(new LabelBuilder().setLabel(`Page (1-${pages})`).setTextInputComponent(input));
}

/** The "jump to page" modal has its own deadline to type in - it shouldn't shrink along with the
 * buttons' idle timeout (which tends to be much shorter). */
const MODAL_TIMEOUT_MS = 60_000;

/** Defaults a page's `allowedMentions` to `NO_PINGS` unless the caller's `render` explicitly set
 * its own - a page can legitimately list `<@userId>` mentions (session history, a user list), and
 * clicking prev/next/jump shouldn't re-ping everyone shown on the page it lands on. */
function withDefaultMentions(payload: MessageEditOptions): MessageEditOptions {
    return { allowedMentions: NO_PINGS, ...payload };
}

export interface AttachPaginationOptions {
    /** Only clicks from this user are accepted - everyone else gets an ephemeral "not yours". */
    invokerId: string;
    pages: number;
    /** IDLE timeout (not absolute) - each click resets the countdown. Default 20s: buttons stay
     * alive while the user is actively paginating, only disappear after being idle. */
    timeoutMs?: number;
    /**
     * Recomputes the whole payload for a page. Called with `interactive: false` when the
     * collector expires, to rebuild the message WITHOUT the navigation row.
     */
    render: (page: number, interactive: boolean) => MessageEditOptions;
}

/**
 * Handles a single click on one of `buildPaginationRow()`'s buttons (first/prev/next/last, or
 * jump via modal) - calling `render`/`i.update()` (or the modal submission's own `.update()`)
 * itself, and resolving to the page it landed on. Resolves `null` if `customId` isn't one of this
 * row's buttons (so it can sit alongside other buttons in a bigger flow - check those first, fall
 * through to this one otherwise - see `forwardMenu.ts`'s own Back button), or if the jump modal
 * was cancelled or given bad input (nothing to update in that case either).
 */
export async function handlePaginationButton(
    i: ButtonInteraction,
    page: number,
    pages: number,
    renderRaw: (page: number) => MessageEditOptions,
): Promise<number | null> {
    const render = (p: number) => withDefaultMentions(renderRaw(p));

    if (i.customId === FIRST_ID) {
        await i.update(render(0));
        return 0;
    }
    if (i.customId === PREV_ID) {
        const next = page > 0 ? page - 1 : pages - 1;
        await i.update(render(next));
        return next;
    }
    if (i.customId === NEXT_ID) {
        const next = page < pages - 1 ? page + 1 : 0;
        await i.update(render(next));
        return next;
    }
    if (i.customId === LAST_ID) {
        await i.update(render(pages - 1));
        return pages - 1;
    }
    if (i.customId !== JUMP_ID) return null;

    const modal = buildJumpModal(pages);
    await i.showModal(modal);
    const submitted = await i
        .awaitModalSubmit({ time: MODAL_TIMEOUT_MS, filter: (m) => m.customId === modal.data.custom_id })
        .catch(() => null);
    if (!submitted?.isFromMessage()) return null;

    const target = Number(submitted.fields.getTextInputValue(JUMP_INPUT_ID));
    if (!Number.isInteger(target) || target < 1 || target > pages) {
        await submitted.reply({ content: `Enter a number between 1 and ${pages}.`, ephemeral: true }).catch(() => { });
        return null;
    }
    const next = target - 1;
    await submitted.update(render(next));
    return next;
}

/** Prev/next with wraparound (first page + "<" goes to the last, and vice-versa) + direct jump via modal. */
export function attachPagination(msg: Message, opts: AttachPaginationOptions): void {
    const { pages, invokerId, render, timeoutMs = 20_000 } = opts;
    let page = 0;

    const collector = msg.createMessageComponentCollector({
        componentType: ComponentType.Button,
        idle: timeoutMs,
    });

    collector.on("collect", async (i) => {
        if (i.user.id !== invokerId) {
            await i.reply({ content: "These buttons aren't yours!", ephemeral: true }).catch(() => { });
            return;
        }

        const next = await handlePaginationButton(i, page, pages, (p) => render(p, true));
        if (next !== null) page = next;
    });

    collector.on("end", async () => {
        await msg.edit(withDefaultMentions(render(page, false))).catch(() => { });
    });
}
