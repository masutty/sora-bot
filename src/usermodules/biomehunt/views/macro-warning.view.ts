import { ContainerBuilder, MessageFlags } from "discord.js";
/** Tells a member their macro can't be read, and who to ask. Only the member is pinged. */
export function macroWarningPayload(memberId: string, ownerIds: readonly string[]) {
    const owners = ownerIds.map((id) => `<@${id}>`).join(" or ");
    const contact = owners ? `${owners}, or this server's staff` : "this server's staff";
    const container = new ContainerBuilder()
        .setAccentColor(0xf0b232)
        .addTextDisplayComponents((td) =>
            td.setContent(
                [
                    `<@${memberId}>`,
                    "### ⚠️ Incompatible macro",
                    "- No biome could be read from your macro's recent messages",
                    "- Switch to another macro",
                    `- Or contact ${contact}`,
                ].join("\n"),
            ),
        );
    return { flags: MessageFlags.IsComponentsV2 as const, components: [container], allowedMentions: { users: [memberId] } };
}
