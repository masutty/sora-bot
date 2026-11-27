import { type MessageComponentInteraction, MessageFlags, PermissionFlagsBits } from "discord.js";
import { config } from "@/config";
import type { BotClient } from "@/core/bot-client";
import { defineComponent } from "@/define";
import { NO_PINGS } from "@/utils/format";
import { cancelPause, checkDismiss, dismissPause, endPauseFromMember, type MemberPause } from "../services/pause.service";
import { reportDismissedPause } from "../services/pause-notice.service";
import {
    buildClosedPauseNotice,
    buildDismissConfirm,
    buildPauseReply,
    PAUSE_NOTICE_PREFIX,
    type PauseOutcome,
} from "../views/pause-notice.view";

export interface PauseNoticeComponentDeps {
    endPause: typeof endPauseFromMember;
    checkDismiss: typeof checkDismiss;
    dismissPause: typeof dismissPause;
    cancelPause: typeof cancelPause;
    reportDismissed: typeof reportDismissedPause;
}

const defaultDeps: PauseNoticeComponentDeps = {
    endPause: endPauseFromMember,
    checkDismiss,
    dismissPause,
    cancelPause,
    reportDismissed: reportDismissedPause,
};

const REFUSALS = {
    not_owner: "This is not yours to resolve.",
    not_active: "This pause is no longer active.",
    not_dismissable: "This message can't be dismissed.",
};

const closed = ({ pause, discordUserId }: MemberPause, outcome: PauseOutcome) => ({
    flags: MessageFlags.IsComponentsV2 as const,
    components: [buildClosedPauseNotice(pause, discordUserId, outcome)],
    allowedMentions: NO_PINGS,
});

const isAdmin = (interaction: MessageComponentInteraction) =>
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) === true || config.bot.ownerIds.includes(interaction.user.id);

/**
 * `biomehunt:pause-notice:<pauseId>[:dismiss|dismiss-confirm:<noticeId>|dismiss-back|cancel]` - the
 * buttons on a Notice. No action is `Understood`. Only the paused member can end or dismiss that
 * exact pause; only an admin can cancel it.
 */
export function pauseNoticeComponent(deps: PauseNoticeComponentDeps = defaultDeps) {
    return defineComponent({
        prefix: PAUSE_NOTICE_PREFIX,
        handle: async (interaction, parts, client: BotClient) => {
            if (!interaction.isButton()) return;
            const [rawId, action, noticeId] = parts;
            const pauseId = Number(rawId);
            const refuse = (content: string) => interaction.reply({ content, flags: MessageFlags.Ephemeral });
            if (!Number.isInteger(pauseId)) {
                await refuse(REFUSALS.not_active);
                return;
            }

            if (action === "dismiss") {
                const check = await deps.checkDismiss(pauseId, interaction.user.id);
                if (check !== "ok") {
                    await refuse(REFUSALS[check]);
                    return;
                }
                await interaction.reply({
                    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
                    components: buildDismissConfirm(pauseId, interaction.message.id),
                });
                return;
            }
            if (action === "dismiss-back") {
                await interaction.update({ components: [buildPauseReply("Nothing changed.")] });
                return;
            }
            if (action === "dismiss-confirm") {
                const result = await deps.dismissPause(pauseId, interaction.user.id);
                if (typeof result === "string") {
                    await interaction.update({ components: [buildPauseReply(REFUSALS[result])] });
                    return;
                }
                await interaction.update({ components: [buildPauseReply("Dismissed. The staff was told.")] });
                await deps.reportDismissed(client, result);
                const notice = await interaction.channel?.messages.fetch(noticeId ?? "").catch(() => null);
                await notice?.edit(closed(result, { kind: "dismissed" })).catch(() => {});
                return;
            }
            if (action === "cancel") {
                if (!isAdmin(interaction)) {
                    await refuse("Only an admin can cancel this.");
                    return;
                }
                const result = await deps.cancelPause(pauseId);
                if (!result) {
                    await refuse(REFUSALS.not_active);
                    return;
                }
                await interaction.update(closed(result, { kind: "cancelled", byDiscordId: interaction.user.id }));
                return;
            }

            const result = await deps.endPause(pauseId, interaction.user.id);
            if (typeof result === "string") {
                await refuse(REFUSALS[result]);
                return;
            }
            await interaction.update(closed(result, { kind: "understood" }));
        },
    });
}
