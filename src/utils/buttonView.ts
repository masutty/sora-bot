import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from "discord.js";
import type { EmbedBuilder, Message } from "discord.js";

/**
 * One button in a `runButtonView` render. `next` computes the state to transition to when
 * this button is clicked - covers both pagination (`next: () => page + 1`) and named tabs
 * (`next: () => "biomes"`) with the same primitive.
 */
export interface ButtonViewButton<S> {
    customId: string;
    label?: string;
    emoji?: string;
    style?: ButtonStyle;
    disabled?: boolean;
    next: (state: S) => S;
}

export interface ButtonViewRender<S> {
    embeds: EmbedBuilder[];
    /** Omit or leave empty to render a static message with no interactive follow-up. */
    buttons?: ButtonViewButton<S>[];
}

export interface RunButtonViewOptions<S> {
    /** Initial state (e.g. starting page number, or starting tab key). */
    state: S;
    /** Only this user's clicks are honored - everyone else gets an ephemeral "not yours" reply. */
    invokerId: string;
    respond: (payload: { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] }) => Promise<Message>;
    /** Pure function: state -> what to show. Called on initial render and after every click. */
    render: (state: S) => ButtonViewRender<S>;
    /** Defaults to 60s, matching the rest of the bot's interactive menus. */
    timeoutMs?: number;
}

function buildRow<S>(buttons: ButtonViewButton<S>[]): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        buttons.map((b) => {
            const btn = new ButtonBuilder().setCustomId(b.customId).setStyle(b.style ?? ButtonStyle.Secondary);
            if (b.label) btn.setLabel(b.label);
            if (b.emoji) btn.setEmoji(b.emoji);
            if (b.disabled) btn.setDisabled(true);
            return btn;
        }),
    );
}

function componentsFor<S>(render: ButtonViewRender<S>): ActionRowBuilder<ButtonBuilder>[] {
    return render.buttons?.length ? [buildRow(render.buttons)] : [];
}

/**
 * Generic stateful button-driven view: renders an embed + buttons from a state value, and on
 * each click re-derives state/render from the clicked button - no manual collector wiring
 * needed at call sites. Covers both classic pagination (state = page index) and named tabs
 * (state = tab key); see `buildHistoryRow`/`buildUserListRow` for the pre-existing bespoke
 * pagination this could eventually be migrated onto, and `runProfileView` for a tabs example.
 */
export async function runButtonView<S>(opts: RunButtonViewOptions<S>): Promise<void> {
    let state = opts.state;
    let current = opts.render(state);

    const msg = await opts.respond({ embeds: current.embeds, components: componentsFor(current) });
    if (!current.buttons?.length) return;

    const collector = msg.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: opts.timeoutMs ?? 60_000,
    });

    collector.on("collect", async (i) => {
        if (i.user.id !== opts.invokerId) {
            await i.reply({ content: "These buttons aren't yours!", ephemeral: true });
            return;
        }

        const clicked = current.buttons?.find((b) => b.customId === i.customId);
        if (!clicked) {
            await i.deferUpdate();
            return;
        }

        state = clicked.next(state);
        current = opts.render(state);
        await i.update({ embeds: current.embeds, components: componentsFor(current) });
    });

    collector.on("end", async () => {
        await msg.edit({ components: [] }).catch(() => {});
    });
}
