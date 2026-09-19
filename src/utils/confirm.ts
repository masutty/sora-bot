import {
    ActionRowBuilder,
    type AttachmentBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
    ContainerBuilder,
    type Message,
    MessageFlags,
} from "discord.js";
import { EmbedFormatter, type FormattedReply } from "./format";
import { Logger } from "./logging";

const logger = new Logger("utils.confirm");

const CONFIRM_ID = "confirm-yes";
const CANCEL_ID = "confirm-no";
const DEFAULT_COLOR = 0x5865f2;

export interface ConfirmField {
    label: string;
    value: string;
}

export interface ConfirmPayload {
    flags: MessageFlags.IsComponentsV2;
    components: (ContainerBuilder | ActionRowBuilder<ButtonBuilder>)[];
    files?: AttachmentBuilder[];
}

/** Row [Confirm] [Cancel] - fixed customId, no conflict between concurrent confirmations because
 * each one only listens for clicks on ITS OWN message (see confirmAction). */
export function buildConfirmRow(): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(CONFIRM_ID)
            .setLabel("Confirm")
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(CANCEL_ID)
            .setLabel("Cancel")
            .setStyle(ButtonStyle.Danger),
    );
}

/** ComponentsV2 container with the action summary, one field per line - ready to go alongside
 * `buildConfirmRow()` in the same `components: [...]`. `color` defaults to the bot's blurple;
 * pass a different one to signal severity (e.g. orange for an overwrite, red for a removal). */
export function buildConfirmContainer(
    title: string,
    fields: ConfirmField[],
    color: number = DEFAULT_COLOR,
    thumbnailAttachment?: string,
): ContainerBuilder {
    const container = new ContainerBuilder().setAccentColor(color);
    const lines = fields.map((f) => `- ${f.label}: \`${f.value}\``).join("\n");
    const content = `**${title}**\n${lines}`;

    if (thumbnailAttachment) {
        container.addSectionComponents((section) =>
            section
                .addTextDisplayComponents((td) => td.setContent(content))
                .setThumbnailAccessory((thumb) => thumb.setURL(`attachment://${thumbnailAttachment}`)),
        );
    } else {
        container.addTextDisplayComponents((td) => td.setContent(content));
    }

    return container;
}

export interface ConfirmActionOptions {
    /** Only clicks from this user count - anyone else gets an ephemeral "not your confirmation"
     * and it doesn't reset the idle timeout. */
    invokerId: string;
    /** Bold question at the top of the summary (e.g. "Remove this record?"). */
    title: string;
    /** Action summary, one field per line (e.g. type/subdomain/domain/target). */
    fields: ConfirmField[];
    /** Container accent - defaults to blurple. Use to signal severity (orange/red). */
    color?: number;
    /** Attachments to upload alongside the confirmation (e.g. an image referenced by `thumbnailAttachment`). */
    files?: AttachmentBuilder[];
    /** Filename (matching one of `files`' `.name`) to show as a small thumbnail next to the summary. */
    thumbnailAttachment?: string;
    /**
     * Sends the initial payload (summary + buttons) and returns the `Message` - `(p) =>
     * interaction.editReply(p)` on an already-deferred interaction, or `(p) => message.reply(p)`
     * for a prefix command. Same convention as `attachPagination`'s `render` (see pagination.ts).
     */
    send: (payload: ConfirmPayload) => Promise<Message>;
    /** Only runs if the invoker clicks Confirm. The return value becomes the message's new content. */
    onConfirm: () => Promise<FormattedReply>;
    /** IDLE timeout (ms, default 20s) - reset on every click from the invoker, not from anyone else. */
    timeoutMs?: number;
}

/**
 * Sends an action summary with Confirm/Cancel buttons (ComponentsV2) and only runs `onConfirm` if
 * the invoker THEMSELVES confirms - cancelling or letting it expire runs nothing. Generalizes the
 * "single invoker + idle timeout" pattern from `attachPagination` to any action that needs
 * confirmation before running (a destructive command, an overwrite, etc).
 */
export async function confirmAction(opts: ConfirmActionOptions): Promise<void> {
    const {
        invokerId,
        title,
        fields,
        color,
        send,
        onConfirm,
        timeoutMs = 20_000,
    } = opts;

    const sent = await send({
        flags: MessageFlags.IsComponentsV2,
        components: [
            buildConfirmContainer(title, fields, color, opts.thumbnailAttachment),
            buildConfirmRow(),
        ],
        ...(opts.files ? { files: opts.files } : {}),
    });

    let handled = false;
    const collector = sent.createMessageComponentCollector({
        componentType: ComponentType.Button,
        idle: timeoutMs,
    });

    collector.on("collect", async (i) => {
        if (i.user.id !== invokerId) {
            await i
                .reply({ content: "This confirmation isn't yours!", ephemeral: true })
                .catch(() => { });
            return;
        }

        handled = true;
        collector.stop();

        if (i.customId === CANCEL_ID) {
            await i.update(EmbedFormatter.warn("Action cancelled.")).catch(() => { });
            return;
        }

        // `onConfirm` usually hits an external API - it can take longer than the ~3s Discord gives
        // to acknowledge a click, and `i.update()` directly would fail with "the application did
        // not respond in time" (silently, since the catch(() => {}) swallowed the error).
        // `deferUpdate` acknowledges immediately, keeping the message as-is, and lets us edit it
        // with `editReply` once `onConfirm` finishes - no deadline.
        await i.deferUpdate().catch(() => { });
        try {
            await i.editReply(await onConfirm());
        } catch (err) {
            logger.error(err instanceof Error ? err : new Error(String(err)));
            await i
                .editReply(EmbedFormatter.error("Error running the action!"))
                .catch(() => { });
        }
    });

    collector.on("end", async () => {
        if (!handled) {
            await sent
                .edit(EmbedFormatter.warn("Confirmation expired."))
                .catch(() => { });
        }
    });
}
