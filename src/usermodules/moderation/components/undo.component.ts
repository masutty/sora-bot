import { ComponentType, type MessageComponentInteraction, MessageFlags } from "discord.js";
import { defineComponent } from "@/define";
import { getCase } from "../repository/cases.repository";
import { getSettings } from "../repository/settings.repository";
import type { CaseService } from "../services/case.service";
import { canModerate, type ModAction } from "../services/permission";
import { caseService } from "../services/runtime";
import { parseUndoParts, UNDO_LABELS, UNDO_PREFIX, UNDO_WINDOW_S } from "../services/undo";
import { type CaseKind, type CaseRow, ModerationError, type ModSettings } from "../types";

const REASON_MAX = 1000;
const MODAL_WAIT_MS = 5 * 60 * 1000;

export interface UndoComponentDeps {
    service(client: Parameters<typeof caseService>[0]): Pick<CaseService, "unwarn" | "unmute" | "unban" | "untemprole">;
    getCase(guildId: string, id: string): Promise<CaseRow | null>;
    getSettings(guildId: string): Promise<Pick<ModSettings, "moderator_role_id">>;
    now(): Date;
}

const ACTION: Partial<Record<CaseKind, ModAction>> = { warn: "moderate", mute: "moderate", temprole: "moderate", ban: "ban" };

const refuse = (i: MessageComponentInteraction, content: string) => i.reply({ content, flags: MessageFlags.Ephemeral });

/** `moderation:undo:<caseId>:<postedAt>` - the undo button on a Created post of the Case Channel. */
export function undoComponent(deps: UndoComponentDeps = { service: caseService, getCase, getSettings, now: () => new Date() }) {
    return defineComponent({
        prefix: UNDO_PREFIX,
        handle: async (interaction, parts, client) => {
            if (!interaction.isButton()) return;
            const id = parseUndoParts(parts);
            if (!id) return void (await refuse(interaction, "This button is not valid."));
            const { caseId } = id;
            if (Math.floor(deps.now().getTime() / 1000) - id.postedAt > UNDO_WINDOW_S) {
                return void (await refuse(interaction, `This button expired, so use \`case ${caseId}\` instead.`));
            }
            const row = interaction.guildId ? await deps.getCase(interaction.guildId, caseId) : null;
            const label = row ? UNDO_LABELS[row.kind] : undefined;
            const action = row ? ACTION[row.kind] : undefined;
            if (!row || !label || action === undefined) return void (await refuse(interaction, `No case \`${caseId}\`.`));
            const member = { permissions: interaction.memberPermissions, roles: interaction.member?.roles };
            if (!canModerate(member, action, await deps.getSettings(row.guild_id))) {
                return void (await refuse(interaction, "You don't have permission to do that."));
            }
            if (row.ended_at) return void (await refuse(interaction, `Case \`${caseId}\` already ended.`));

            const modalId = `${UNDO_PREFIX}:modal:${caseId}:${interaction.id}`;
            await interaction.showModal({
                custom_id: modalId,
                title: `${label} ${caseId}`.slice(0, 45),
                components: [
                    {
                        type: ComponentType.Label,
                        label: "Reason (optional)",
                        component: {
                            type: ComponentType.TextInput,
                            custom_id: "reason",
                            style: 1,
                            required: false,
                            max_length: REASON_MAX,
                        },
                    },
                ],
            });
            const submit = await interaction
                .awaitModalSubmit({ filter: (s) => s.customId === modalId && s.user.id === interaction.user.id, time: MODAL_WAIT_MS })
                .catch(() => null);
            if (!submit) return;

            // Acknowledge the submit at once: the revoke (DB, DM, Case Channel post) can take longer than the
            // 3s Discord allows, and a late answer shows "Something went wrong" even though it worked.
            const fromMessage = submit.isFromMessage();
            if (fromMessage) await submit.deferUpdate();
            else await submit.deferReply({ flags: MessageFlags.Ephemeral });

            const reason = submit.fields.getTextInputValue("reason").trim() || undefined;
            const service = deps.service(client);
            const base = { guildId: row.guild_id, by: interaction.user.id, reason };
            try {
                if (row.kind === "warn") await service.unwarn({ ...base, caseId });
                else if (row.kind === "mute") await service.unmute({ ...base, userId: row.user_id });
                else if (row.kind === "ban") await service.unban({ ...base, userId: row.user_id });
                else await service.untemprole({ ...base, userId: row.user_id, roleId: row.role_id as string });
            } catch (err) {
                const message = err instanceof ModerationError ? err.message : "Something went wrong, the case was not changed.";
                await submit.followUp({ content: message, flags: MessageFlags.Ephemeral });
                if (err instanceof ModerationError) return;
                throw err;
            }
            if (!fromMessage) {
                await submit.editReply({ content: `${label} done.` });
                return;
            }
            // The tracker may already have stripped the button; this is the fallback after a restart.
            const containers = interaction.message.components.filter((c) => c.type === ComponentType.Container).map((c) => c.toJSON());
            await submit.editReply({ components: containers }).catch(() => {});
        },
    });
}
