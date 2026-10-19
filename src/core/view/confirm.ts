import { ActionRowBuilder, type AttachmentBuilder, type ButtonBuilder, ButtonStyle, ContainerBuilder, MessageFlags } from "discord.js";
import { EmbedFormatter } from "@/utils/format";
import { Logger } from "@/utils/logging";
import { config } from "../../config";
import { describeCommandError } from "../command/user-facing-error";
import { defineView, type RenderKit, type ViewDefinition, type ViewPayload } from "./view";

const logger = new Logger("core.view.confirm");

const DEFAULT_COLOR = 0x5865f2;

export interface ConfirmField {
    label: string;
    value: string;
}

export interface ConfirmOptions {
    /** `<cog>.<name>` of the View. */
    name: string;
    /** Bold question at the top of the summary (e.g. "Remove this record?"). Mentions never ping. */
    title: string;
    /** The action's summary, one `- label: \`value\`` line each. Ignored when `body` is set. */
    fields?: ConfirmField[];
    /**
     * Free markdown shown under the title instead of `fields`. An array splits it into blocks: the
     * first shares the title's TextDisplay, each other one is its own TextDisplay below it.
     */
    body?: string | string[];
    /** Container accent - default blurple. Use it for severity (orange overwrite, red removal). */
    color?: number;
    /** Confirm button label and style. Default "Confirm" / Success. */
    confirmLabel?: string;
    confirmStyle?: ButtonStyle;
    /** Cancel button label and style. Default "Cancel" / Danger. */
    cancelLabel?: string;
    cancelStyle?: ButtonStyle;
    /** Attachments sent with the question (e.g. the image `thumbnailAttachment` names). */
    files?: AttachmentBuilder[];
    /** Filename (one of `files`) shown as a thumbnail next to the summary. */
    thumbnailAttachment?: string;
    /**
     * Runs only when the user confirms; its payload is the final screen. It may be slow (the click
     * is acknowledged in time). A throw is logged and shown as "Error running the action!" (a
     * UserFacingError shows its own message), and the confirm resolves `false`.
     */
    onConfirm: () => Promise<ViewPayload>;
    /** Idle timeout when this is the root. Default config.ui.confirmTimeoutMs. */
    timeoutMs?: number;
}

export type ConfirmState = { phase: "asking" } | { phase: "confirmed" | "cancelled" | "failed"; payload: ViewPayload };

/** The summary container: bold title + one line per field (or the `body` blocks). */
function summaryContainer(opts: ConfirmOptions): ContainerBuilder {
    const container = new ContainerBuilder().setAccentColor(opts.color ?? DEFAULT_COLOR);
    const blocks = typeof opts.body === "string" ? [opts.body] : (opts.body ?? []);
    const [first, ...rest] = opts.body !== undefined ? blocks : [(opts.fields ?? []).map((f) => `- ${f.label}: \`${f.value}\``).join("\n")];
    const content = `**${opts.title}**\n${first ?? ""}`;
    const thumbnail = opts.thumbnailAttachment;
    if (thumbnail) {
        container.addSectionComponents((section) =>
            section
                .addTextDisplayComponents((td) => td.setContent(content))
                .setThumbnailAccessory((t) => t.setURL(`attachment://${thumbnail}`)),
        );
    } else {
        container.addTextDisplayComponents((td) => td.setContent(content));
    }
    for (const block of rest) container.addTextDisplayComponents((td) => td.setContent(block));
    return container;
}

function confirmRow(kit: RenderKit, opts: ConfirmOptions): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        kit.button("yes", (b) => b.setLabel(opts.confirmLabel ?? "Confirm").setStyle(opts.confirmStyle ?? ButtonStyle.Success)),
        kit.button("no", (b) => b.setLabel(opts.cancelLabel ?? "Cancel").setStyle(opts.cancelStyle ?? ButtonStyle.Danger)),
    );
}

/**
 * A yes/no confirmation before an action: the summary with [Confirm] [Cancel]. Resolves `true`
 * once the user confirmed and `onConfirm` succeeded (its payload is the final screen); `false` on
 * Cancel ("Action cancelled.") or when `onConfirm` threw (the error is the final screen);
 * `undefined` on idle expiry ("Confirmation expired.").
 * Opened as a child (`c.open`), the opener's next screen replaces `onConfirm`'s payload (a failure
 * is still told to the user, as a private notice), and it runs on the root's clock (e.g. a flow step's).
 *
 * @example
 * await ctx.open(confirm({
 *     name: "biomehunt.recalculate-user",
 *     title: `Recalculate <@${user.id}>?`,
 *     fields: [{ label: "Sessions", value: String(count) }],
 *     onConfirm: async () => EmbedFormatter.success(await recalculate(user.id)),
 * }), undefined);
 */
export function confirm(opts: ConfirmOptions): ViewDefinition<ConfirmState, boolean, void> {
    return defineView<ConfirmState, boolean, void>({
        name: opts.name,
        initial: () => ({ phase: "asking" }),
        timeoutMs: opts.timeoutMs ?? config.ui.confirmTimeoutMs,
        onExpire: () => EmbedFormatter.warn("Confirmation expired."),
        render: (state, kit) => {
            if (state.phase !== "asking") return state.payload;
            return {
                flags: MessageFlags.IsComponentsV2,
                components: [summaryContainer(opts), confirmRow(kit, opts)],
                ...(opts.files ? { files: opts.files } : {}),
            };
        },
        on: {
            yes: async (c) => {
                try {
                    const payload = await opts.onConfirm();
                    c.done(true);
                    return { phase: "confirmed", payload };
                } catch (err) {
                    const described = describeCommandError(err);
                    if (described.kind === "internal")
                        logger.error(err instanceof Error ? err : new Error(String(err)), { view: opts.name });
                    const message = described.kind === "user" ? described.message : "Error running the action!";
                    // As a child, the opener's next screen replaces this one - tell the user privately instead.
                    if (c.isChild) await c.notify(message);
                    c.done(false);
                    return { phase: "failed", payload: EmbedFormatter.error(message) };
                }
            },
            no: (c) => {
                c.done(false);
                return { phase: "cancelled", payload: EmbedFormatter.warn("Action cancelled.") };
            },
        },
    });
}
