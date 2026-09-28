import {
    ActionRowBuilder,
    type Message,
    type MessageCollector,
    type MessageComponentInteraction,
    MessageFlags,
    ModalBuilder,
    type ModalSubmitInteraction,
    TextInputBuilder,
    TextInputStyle,
} from "discord.js";
import { NO_PINGS } from "@/utils/format";
import { type Answerable, createInteractionAnswers } from "./interaction-answers";
import type { ModalSpec, ViewPayload } from "./view";
import type { ComponentEvent, TextEvent, ViewTransport } from "./view-engine";

/** How long the short reply to a typed message (a text `notify`) stays before it's deleted. */
const TEXT_NOTIFY_TTL_MS = 10_000;

const asAnswerable = (raw: unknown) => raw as Answerable;

function componentEvent(i: MessageComponentInteraction | ModalSubmitInteraction): ComponentEvent {
    const values = "values" in i && Array.isArray(i.values) ? (i.values as string[]) : [];
    return { kind: "component", customId: i.customId, userId: i.user.id, values, raw: i };
}

function buildModal(spec: ModalSpec, customId: string): ModalBuilder {
    const modal = new ModalBuilder().setCustomId(customId).setTitle(spec.title);
    for (const f of spec.fields) {
        const input = new TextInputBuilder()
            .setCustomId(f.key)
            .setLabel(f.label)
            .setStyle(f.style === "paragraph" ? TextInputStyle.Paragraph : TextInputStyle.Short)
            .setRequired(f.required ?? true);
        if (f.value !== undefined) input.setValue(f.value);
        if (f.placeholder !== undefined) input.setPlaceholder(f.placeholder);
        if (f.maxLength !== undefined) input.setMaxLength(f.maxLength);
        modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    }
    return modal;
}

export interface DiscordTransportOptions {
    /**
     * Edits the View's message when no click token can - an ephemeral message rejects the bot's own
     * `message.edit`. A slash command passes its interaction's webhook edit (the original response
     * and ephemeral follow-ups are both editable through it).
     */
    editMessage?: (message: Message, payload: ViewPayload) => Promise<unknown>;
}

/**
 * The ViewTransport for a sent discord.js message. Clicks come from a component collector with no
 * filter and no time - the engine owns access (so a stranger's click gets its "not yours") and the
 * idle timer. Typed text comes from a channel collector (bots filtered out) that only runs while
 * the engine asks for text. Every interaction is answered exactly once through
 * `createInteractionAnswers`. While open, Discord errors on render/acknowledge/notify reject (the
 * engine logs them); after `close()` nothing listens anymore, and late calls still answer their
 * interaction but never throw.
 */
export function createDiscordTransport(message: Message, opts: DiscordTransportOptions = {}): ViewTransport {
    const answers = createInteractionAnswers();
    let onEvent: ((e: ComponentEvent | TextEvent) => Promise<void>) | null = null;
    let components: { stop(): void } | null = null;
    let text: MessageCollector | null = null;
    let closed = false;
    /** Cancels of the modal waits in progress - `close()` resolves them all with `null`. */
    const modalWaits = new Set<() => void>();

    /**
     * Edits the View's message. An ephemeral message can't be edited through the bot's own REST
     * route, only through an interaction token: the newest click that updated/deferred it, else the
     * seeded editor (the command's token). A regular message uses `message.edit` (no 15min expiry).
     */
    function editMessage(payload: object): Promise<unknown> {
        if (message.flags.has(MessageFlags.Ephemeral)) {
            const editor = answers.lastEditor();
            if (editor) return editor.editReply(payload);
            if (opts.editMessage) return opts.editMessage(message, payload as ViewPayload);
        }
        return message.edit(payload as ViewPayload);
    }

    /** After close, a failure is nobody's business: the View is gone. */
    function afterClose<T>(p: Promise<T>): Promise<T | undefined> {
        return p.catch((err) => {
            if (closed) return undefined;
            throw err;
        });
    }

    return {
        listen(receiver) {
            onEvent = receiver;
            if (closed || components) return;
            const collector = message.createMessageComponentCollector();
            collector.on("collect", (i) => void onEvent?.(componentEvent(i)));
            components = collector;
        },

        setTextListening(on) {
            if (!on) {
                text?.stop();
                text = null;
                return;
            }
            if (closed || text) return;
            const channel = message.channel;
            if (!("createMessageCollector" in channel)) return;
            text = channel.createMessageCollector({ filter: (m) => !m.author.bot });
            text.on("collect", (m) => void onEvent?.({ kind: "text", userId: m.author.id, content: m.content, raw: m }));
        },

        async render(e, payload) {
            const op = e ? answers.render(asAnswerable(e.raw), payload, editMessage) : editMessage(payload);
            await afterClose(op);
        },

        async acknowledge(e) {
            await afterClose(answers.acknowledge(asAnswerable(e.raw)));
        },

        async notify(e, content) {
            if (e.kind === "component") {
                await afterClose(answers.notify(asAnswerable(e.raw), content));
                return;
            }
            const typed = e.raw as Message;
            const sent = await typed.reply({ content, allowedMentions: { ...NO_PINGS, repliedUser: false } }).catch(() => null);
            if (sent) setTimeout(() => void sent.delete().catch(() => {}), TEXT_NOTIFY_TTL_MS).unref?.();
        },

        async modal(e, spec, customId, timeoutMs, signal) {
            const clicked = e.raw as MessageComponentInteraction;
            try {
                const shown = await answers.showModal(asAnswerable(clicked), buildModal(spec, customId));
                // Already answered, or a modal submit (Discord can't answer one with a modal).
                if (!shown)
                    throw new Error(
                        `Can't show modal "${customId}": the interaction was already answered or can't show a modal (a modal submit)`,
                    );
            } catch (err) {
                // A bad ModalSpec, a rejected showModal or an interaction that can't show one:
                // answer it (no "interaction failed") and reject, so the engine logs it - it's a
                // bug, not a closed modal.
                await answers.acknowledge(asAnswerable(clicked)).catch(() => {});
                throw err;
            }
            const submitted = clicked
                .awaitModalSubmit({ filter: (s) => s.customId === customId && s.user.id === e.userId, time: timeoutMs })
                .then((submit) => {
                    const values: Record<string, string> = {};
                    for (const f of spec.fields) values[f.key] = submit.fields.getTextInputValue(f.key);
                    return { values, ack: componentEvent(submit) };
                })
                // Timed out (or its collector ended): to the engine, the modal was closed.
                .catch(() => null);
            // awaitModalSubmit can't be stopped from outside: a cancel (signal / close) resolves
            // null at once, and a submit that still arrives is acknowledged here, never left unanswered.
            return new Promise((resolve) => {
                let settled = false;
                const cancel = () => {
                    if (settled) return;
                    settled = true;
                    modalWaits.delete(cancel);
                    resolve(null);
                };
                if (closed || signal?.aborted) cancel();
                else {
                    modalWaits.add(cancel);
                    signal?.addEventListener("abort", cancel, { once: true });
                }
                void submitted.then((res) => {
                    signal?.removeEventListener("abort", cancel);
                    if (settled) {
                        if (res) void answers.acknowledge(asAnswerable(res.ack.raw)).catch(() => {});
                        return;
                    }
                    settled = true;
                    modalWaits.delete(cancel);
                    resolve(res);
                });
            });
        },

        async deleteText(e) {
            await (e.raw as Message).delete().catch(() => {});
        },

        close() {
            closed = true;
            onEvent = null;
            components?.stop();
            components = null;
            text?.stop();
            text = null;
            for (const cancel of [...modalWaits]) cancel();
        },
    };
}
