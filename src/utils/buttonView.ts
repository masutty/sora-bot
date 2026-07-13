import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from "discord.js";
import type { EmbedBuilder, Message } from "discord.js";
import { Logger } from "./logging";

const logger = new Logger("utils.buttonView");

/** `render()` is expected to be pure/in-memory (any DB work belongs upstream, before runButtonView is called) - it should never be slow on its own. */
const SLOW_RENDER_MS = 250;
/** `respond()`/`i.update()` are Discord API round-trips - slowness here is network/Discord-side, not ours. */
const SLOW_ROUNDTRIP_MS = 1500;

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
    /** Each inner array is one row (ActionRow, max 5 buttons); up to 5 rows - Discord's own limits. Omit or leave empty for a static message with no interactive follow-up. */
    buttons?: ButtonViewButton<S>[][];
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

function buttonRows<S>(render: ButtonViewRender<S>): ButtonViewButton<S>[][] {
    return (render.buttons ?? []).filter((row) => row.length > 0);
}

function componentsFor<S>(render: ButtonViewRender<S>): ActionRowBuilder<ButtonBuilder>[] {
    return buttonRows(render).map(buildRow);
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

    const renderStart = Date.now();
    let current = opts.render(state);
    const renderMs = Date.now() - renderStart;

    const respondStart = Date.now();
    const msg = await opts.respond({ embeds: current.embeds, components: componentsFor(current) });
    const respondMs = Date.now() - respondStart;
    logSlowness("initial", renderMs, respondMs);

    if (buttonRows(current).length === 0) return;

    const collector = msg.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: opts.timeoutMs ?? 60_000,
    });

    collector.on("collect", async (i) => {
        if (i.user.id !== opts.invokerId) {
            await i.reply({ content: "These buttons aren't yours!", ephemeral: true });
            return;
        }

        const clicked = buttonRows(current).flat().find((b) => b.customId === i.customId);
        if (!clicked) {
            await i.deferUpdate();
            return;
        }

        state = clicked.next(state);

        const clickRenderStart = Date.now();
        current = opts.render(state);
        const clickRenderMs = Date.now() - clickRenderStart;

        const updateStart = Date.now();
        await i.update({ embeds: current.embeds, components: componentsFor(current) });
        const updateMs = Date.now() - updateStart;
        logSlowness(`click:${i.customId}`, clickRenderMs, updateMs);
    });

    collector.on("end", async () => {
        await msg.edit({ components: [] }).catch(() => {});
    });
}

/**
 * `renderMs` slow means our own code is doing unexpected work in `render()` (shouldn't happen -
 * it's meant to be pure/in-memory). `roundtripMs` slow means Discord's API/network, not us -
 * useful for telling "is this DB load" from "is this just Discord being slow" at a glance.
 */
function logSlowness(label: string, renderMs: number, roundtripMs: number): void {
    if (renderMs <= SLOW_RENDER_MS && roundtripMs <= SLOW_ROUNDTRIP_MS) return;
    logger.warn(`Slow button view (${label}): render=${renderMs}ms discord_roundtrip=${roundtripMs}ms`);
}
