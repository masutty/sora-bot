import { MessageFlags } from "discord.js";
import { NO_PINGS } from "@/utils/format";

/**
 * The slice of a discord.js MessageComponentInteraction / ModalSubmitInteraction that answering
 * uses. A modal submit has `isFromMessage` (only one from a message can `update`/`deferUpdate`).
 */
export interface Answerable {
    update(body: object): Promise<unknown>;
    deferUpdate(): Promise<unknown>;
    editReply(body: object): Promise<unknown>;
    reply(body: object): Promise<unknown>;
    followUp(body: object): Promise<unknown>;
    showModal?(modal: object): Promise<unknown>;
    isFromMessage?(): boolean;
}

/** How an interaction was answered. "updated"/"deferred": its token edits the View's message; "replied": it edits an ephemeral reply. */
type AnswerState = "none" | "updated" | "deferred" | "replied" | "modal";

interface Entry {
    state: AnswerState;
    /** The last queued call - every call on this interaction runs after it. */
    tail: Promise<void>;
}

/**
 * Answers each interaction exactly once, whatever order the engine calls in. The engine may fire
 * an acknowledge (its ACK_DEADLINE_MS watchdog) and then render/notify the same interaction
 * while that deferUpdate is still in flight, so calls per interaction are serialized and each one
 * picks update-vs-edit from this tracker's state - not from discord.js's `deferred`/`replied`,
 * which flip only once the request resolves. A call that fails leaves the state untouched.
 */
export interface InteractionAnswers {
    /** Unanswered → `update`; updated/deferred → `editReply`; replied/modal, or a submit not from a message → `editMessage`. */
    render(i: Answerable, payload: object, editMessage: (payload: object) => Promise<unknown>): Promise<void>;
    /** Unanswered → `deferUpdate`; otherwise nothing. */
    acknowledge(i: Answerable): Promise<void>;
    /** Unanswered → ephemeral `reply`; otherwise ephemeral `followUp`. */
    notify(i: Answerable, content: string): Promise<void>;
    /** Shows `modal` if the interaction is unanswered; false (nothing sent) otherwise. */
    showModal(i: Answerable, modal: object): Promise<boolean>;
    /** The latest interaction whose token edits the View's message - the way to edit an ephemeral one. */
    lastEditor(): Answerable | null;
}

export function createInteractionAnswers(): InteractionAnswers {
    const entries = new WeakMap<Answerable, Entry>();
    let editor: Answerable | null = null;

    function enqueue<T>(i: Answerable, op: (entry: Entry) => Promise<T>): Promise<T> {
        let entry = entries.get(i);
        if (!entry) {
            entry = { state: "none", tail: Promise.resolve() };
            entries.set(i, entry);
        }
        const current = entry;
        const run = current.tail.then(() => op(current));
        current.tail = run.then(
            () => {},
            () => {},
        );
        return run;
    }

    const canUpdate = (i: Answerable) => !i.isFromMessage || i.isFromMessage();
    const ephemeral = (content: string) => ({ content, flags: MessageFlags.Ephemeral, allowedMentions: NO_PINGS });

    return {
        render(i, payload, editMessage) {
            return enqueue(i, async (entry) => {
                if (entry.state === "none" && canUpdate(i)) {
                    await i.update(payload);
                    entry.state = "updated";
                    editor = i;
                } else if (entry.state === "updated" || entry.state === "deferred") {
                    await i.editReply(payload);
                } else {
                    await editMessage(payload);
                }
            });
        },

        acknowledge(i) {
            return enqueue(i, async (entry) => {
                if (entry.state !== "none" || !canUpdate(i)) return;
                await i.deferUpdate();
                entry.state = "deferred";
                editor = i;
            });
        },

        notify(i, content) {
            return enqueue(i, async (entry) => {
                if (entry.state === "none") {
                    await i.reply(ephemeral(content));
                    entry.state = "replied";
                } else {
                    await i.followUp(ephemeral(content));
                }
            });
        },

        showModal(i, modal) {
            return enqueue(i, async (entry) => {
                if (entry.state !== "none" || !i.showModal) return false;
                await i.showModal(modal);
                entry.state = "modal";
                return true;
            });
        },

        lastEditor: () => editor,
    };
}
