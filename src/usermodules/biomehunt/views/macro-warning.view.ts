import { ContainerBuilder, MessageFlags } from "discord.js";
import { errorIdLine } from "@/utils/trace";

/** `owners` is empty when no bot owner is configured. */
function unknownMacro(owners: string): string[] {
    return [
        "### ⚠️ I can't recognize your macro!",
        owners
            ? `- Switch to another macro, or ask the staff to contact ${owners} about adding support for yours`
            : "- Switch to another macro, or ask the staff about adding support for yours",
    ];
}

function failingMacro(macro: string, owners: string): string[] {
    return [
        "### ⚠️ I can't get any biomes or merchants from your macro!",
        `- Detected macro: \`${macro}\``,
        "- If your macro reports biomes, check that biome notifications are on",
        "- If your macro reports merchants, check that merchant notifications are on",
        `-# If this is a mistake, contact a staff member${owners ? ` or send a direct message to ${owners}` : ""}`,
    ];
}

/**
 * Tells a member what is wrong with their macro, and who to ask. `macro` is `null` when
 * unrecognized; `ref` finds the matching log lines. Only the member is pinged.
 */
export function macroWarningPayload(macro: string | null, memberId: string, ownerIds: readonly string[], ref: string) {
    const owners = ownerIds.map((id) => `<@${id}>`).join(" or ");
    const lines = macro ? failingMacro(macro, owners) : unknownMacro(owners);
    const container = new ContainerBuilder()
        .setAccentColor(0xf0b232)
        .addTextDisplayComponents((td) => td.setContent([`<@${memberId}>`, ...lines, errorIdLine(ref)].join("\n")));
    return { flags: MessageFlags.IsComponentsV2 as const, components: [container], allowedMentions: { users: [memberId] } };
}
