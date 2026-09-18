import {
    ActionRowBuilder,
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

        if (i.customId === FIRST_ID) {
            page = 0;
            await i.update(render(page, true));
            return;
        }

        if (i.customId === PREV_ID) {
            page = page > 0 ? page - 1 : pages - 1;
            await i.update(render(page, true));
            return;
        }

        if (i.customId === NEXT_ID) {
            page = page < pages - 1 ? page + 1 : 0;
            await i.update(render(page, true));
            return;
        }

        if (i.customId === LAST_ID) {
            page = pages - 1;
            await i.update(render(page, true));
            return;
        }

        if (i.customId !== JUMP_ID) return;

        const modal = buildJumpModal(pages);
        await i.showModal(modal);
        const submitted = await i
            .awaitModalSubmit({ time: MODAL_TIMEOUT_MS, filter: (m) => m.customId === modal.data.custom_id })
            .catch(() => null);
        if (!submitted?.isFromMessage()) return;

        const target = Number(submitted.fields.getTextInputValue(JUMP_INPUT_ID));
        if (!Number.isInteger(target) || target < 1 || target > pages) {
            await submitted.reply({ content: `Enter a number between 1 and ${pages}.`, ephemeral: true }).catch(() => { });
            return;
        }
        page = target - 1;
        await submitted.update(render(page, true));
    });

    collector.on("end", async () => {
        await msg.edit(render(page, false)).catch(() => { });
    });
}
