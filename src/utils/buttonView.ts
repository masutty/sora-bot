import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from "discord.js";
import type { ContainerBuilder, EmbedBuilder, Message, MessageFlags, MessageMentionOptions } from "discord.js";
import { NO_PINGS } from "./format";
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

/**
 * Full message content, minus buttons - either classic embeds or a ComponentsV2 container set.
 * Deliberately narrower than discord.js's own `MessageEditOptions`: that type's `flags` field is
 * NOT interchangeable between `message.reply()` and `interaction.editReply()` (different sibling
 * types, `MessageReplyOptions` vs `MessageEditOptions`), so a single generic `respond` callback
 * bridging both call styles can't be typed through it. This union is exactly the two shapes this
 * module actually produces, and both `.reply()`/`.editReply()`/`.update()`/`.edit()` accept either.
 */
export type ButtonViewPayload =
    | { embeds: EmbedBuilder[]; allowedMentions?: MessageMentionOptions }
    | { flags: MessageFlags.IsComponentsV2; components: ContainerBuilder[]; allowedMentions?: MessageMentionOptions };

/** `ButtonViewPayload` plus its button rows merged in - what `respond`/`i.update()` are actually called with. */
export type ButtonViewFinalPayload =
    | { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[]; allowedMentions?: MessageMentionOptions }
    | { flags: MessageFlags.IsComponentsV2; components: (ContainerBuilder | ActionRowBuilder<ButtonBuilder>)[]; allowedMentions?: MessageMentionOptions };

export interface ButtonViewRender<S> {
    /** Content only - button rows are appended separately, not part of this. */
    payload: ButtonViewPayload;
    /** Each inner array is one row (ActionRow, max 5 buttons); up to 5 rows - Discord's own limits. Omit or leave empty for a static message with no interactive follow-up. */
    buttons?: ButtonViewButton<S>[][];
}

export interface RunButtonViewOptions<S> {
    /** Initial state (e.g. starting page number, or starting tab key). */
    state: S;
    /** Only this user's clicks are honored - everyone else gets an ephemeral "not yours" reply. */
    invokerId: string;
    respond: (payload: ButtonViewFinalPayload) => Promise<Message>;
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

/**
 * Merges a render's content payload with its button rows into one final message payload.
 * ComponentsV2 content and its buttons share the SAME `components` array (there's no separate
 * `embeds` slot on a ComponentsV2 message) - classic embed content puts the button rows in
 * `components` alongside `embeds`, so this one merge works for both shapes.
 *
 * Also defaults `allowedMentions` to `NO_PINGS` unless the render explicitly set its own - a
 * render can legitimately show a `<@userId>`/`<@&roleId>` mention (a leaderboard, a user list,
 * a role echoed back on a config screen), and nobody clicking a tab/page button should trigger a
 * fresh ping for everyone still listed on the re-rendered page.
 */
function mergePayload<S>(render: ButtonViewRender<S>): ButtonViewFinalPayload {
    const rows = buttonRows(render).map(buildRow);
    const allowedMentions = render.payload.allowedMentions ?? NO_PINGS;
    if ("embeds" in render.payload) {
        return { ...render.payload, components: rows, allowedMentions };
    }
    return { ...render.payload, components: [...render.payload.components, ...rows], allowedMentions };
}

/**
 * Generic stateful button-driven view: renders a payload + buttons from a state value, and on
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
    const msg = await opts.respond(mergePayload(current));
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
        await i.update(mergePayload(current));
        const updateMs = Date.now() - updateStart;
        logSlowness(`click:${i.customId}`, clickRenderMs, updateMs);
    });

    collector.on("end", async () => {
        // Re-render the current state's content WITHOUT buttons, rather than truncating
        // `components` to `[]` - on a ComponentsV2 message that would wipe the content itself,
        // since content and buttons share the same array there.
        await msg.edit({ ...current.payload, allowedMentions: current.payload.allowedMentions ?? NO_PINGS }).catch(() => { });
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
