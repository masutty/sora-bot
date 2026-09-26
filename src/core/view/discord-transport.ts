import {
    ActionRowBuilder, type Message, type MessageCollector, type MessageComponentInteraction,
    MessageFlags, ModalBuilder, type ModalSubmitInteraction, TextInputBuilder, TextInputStyle,
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

/**
 * The ViewTransport for a sent discord.js message. Clicks come from a component collector with no
 * filter and no time - the engine owns access (so a stranger's click gets its "not yours") and the
 * idle timer. Typed text comes from a channel collector (bots filtered out) that only runs while
 * the engine asks for text. Every interaction is answered exactly once through
 * `createInteractionAnswers`. After `close()` nothing listens anymore, but late calls still answer
 * their interaction and never throw.
 */
export function createDiscordTransport(message: Message): ViewTransport {
    const answers = createInteractionAnswers();
    let onEvent: ((e: ComponentEvent | TextEvent) => Promise<void>) | null = null;
    let components: { stop(): void } | null = null;
    let text: MessageCollector | null = null;
    let closed = false;

    /**
     * Edits the View's message. An ephemeral message can't be edited through the bot's own REST
     * route, only through an interaction token that edits it (one that updated/deferred it).
     */
    function editMessage(payload: object): Promise<unknown> {
        const editor = answers.lastEditor();
        if (editor && message.flags.has(MessageFlags.Ephemeral)) return editor.editReply(payload);
        return message.edit(payload as ViewPayload);
    }

    /** After close, a failure is nobody's business: the View is gone. */
    function afterClose<T>(p: Promise<T>): Promise<T | undefined> {
        return closed ? p.catch(() => undefined) : p;
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
            await answers.acknowledge(asAnswerable(e.raw)).catch(() => {});
        },

        async notify(e, content) {
            if (e.kind === "component") {
                await answers.notify(asAnswerable(e.raw), content).catch(() => {});
                return;
            }
            const typed = e.raw as Message;
            const sent = await typed.reply({ content, allowedMentions: { ...NO_PINGS, repliedUser: false } }).catch(() => null);
            if (sent) setTimeout(() => void sent.delete().catch(() => {}), TEXT_NOTIFY_TTL_MS).unref?.();
        },

        async modal(e, spec, customId, timeoutMs) {
            const clicked = e.raw as MessageComponentInteraction;
            try {
                const shown = await answers.showModal(asAnswerable(clicked), buildModal(spec, customId));
                if (!shown) return null;
                const submit = await clicked.awaitModalSubmit({
                    filter: (s) => s.customId === customId && s.user.id === e.userId,
                    time: timeoutMs,
                });
                const values: Record<string, string> = {};
                for (const f of spec.fields) values[f.key] = submit.fields.getTextInputValue(f.key);
                return { values, ack: componentEvent(submit) };
            } catch {
                // Timed out, or the modal couldn't be shown: to the engine, both are "closed".
                return null;
            }
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
        },
    };
}
