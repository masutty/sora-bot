import { ButtonStyle, ContainerBuilder, type Message, MessageFlags } from "discord.js";
import { defineView, type ViewDefinition } from "@/define";
import { EmbedFormatter, NO_PINGS } from "@/utils/format";
import { validateCapture } from "../services/capture";
import { settings } from "../settings";
import { StickyError } from "../types";

export interface CaptureState {
    phase: "waiting" | "saved" | "cancelled";
    line: string;
}

export interface CaptureOptions {
    /** Shown while waiting, e.g. "Send the sticky for <#123>." */
    title: string;
    /** Stores the content; resolves with the success line. A StickyError keeps the view waiting. */
    save(content: string): Promise<string>;
}

const box = () => new ContainerBuilder().setAccentColor(settings.accentColor);

const text = (content: string) => ({
    flags: MessageFlags.IsComponentsV2 as const,
    components: [box().addTextDisplayComponents((td) => td.setContent(content))],
    allowedMentions: NO_PINGS,
});

/** Waits for one plain-text message from the invoker and stores it as the sticky. */
export function captureView(opts: CaptureOptions): ViewDefinition<CaptureState, boolean, void> {
    return defineView<CaptureState, boolean, void>({
        name: "sticky.capture",
        initial: () => ({ phase: "waiting", line: "" }),
        timeoutMs: settings.captureTimeoutMs,
        fixedTimeout: true,
        access: "invoker",
        deleteTextInput: true,
        onExpire: () => EmbedFormatter.warn("Cancelled because no message came in 30 seconds."),
        render: (state, kit) => {
            if (state.phase === "saved") return { ...text(state.line), acceptText: false };
            if (state.phase === "cancelled") return { ...text("Cancelled."), acceptText: false };
            return {
                flags: MessageFlags.IsComponentsV2,
                components: [
                    box()
                        .addTextDisplayComponents((td) => td.setContent(opts.title))
                        .addActionRowComponents(kit.row(kit.button("cancel", (b) => b.setLabel("Cancel").setStyle(ButtonStyle.Secondary)))),
                ],
                allowedMentions: NO_PINGS,
                acceptText: true,
            };
        },
        on: {
            cancel: (c) => {
                c.done(false);
                return { phase: "cancelled", line: "" };
            },
        },
        onText: async (c) => {
            const checked = validateCapture(c.raw as Message);
            if (!checked.ok) {
                await c.notify(checked.reason);
                return;
            }
            try {
                const line = await opts.save(checked.content);
                c.done(true);
                return { phase: "saved", line };
            } catch (err) {
                if (!(err instanceof StickyError)) throw err;
                await c.notify(err.message);
            }
        },
    });
}
