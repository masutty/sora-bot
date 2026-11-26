import { ContainerBuilder, MessageFlags } from "discord.js";
export type MacroProblem = "incompatible" | "failing";

const PROBLEMS: Record<MacroProblem, { title: string; lines: string[] }> = {
    incompatible: {
        title: "Incompatible macro",
        lines: ["Your macro isn't recognized, and no biome or merchant could be read", "Switch to another macro"],
    },
    failing: {
        title: "Macro error",
        lines: ["Your macro is recognized, but no biome or merchant could be read", "Check that it is up to date and reporting biomes"],
    },
};

/** Tells a member what is wrong with their macro, and who to ask. Only the member is pinged. */
export function macroWarningPayload(problem: MacroProblem, memberId: string, ownerIds: readonly string[]) {
    const owners = ownerIds.map((id) => `<@${id}>`).join(" or ");
    const contact = owners ? `${owners}, or this server's staff` : "this server's staff";
    const { title, lines } = PROBLEMS[problem];
    const container = new ContainerBuilder()
        .setAccentColor(0xf0b232)
        .addTextDisplayComponents((td) =>
            td.setContent([`<@${memberId}>`, `### ⚠️ ${title}`, ...lines.map((line) => `- ${line}`), `- Or contact ${contact}`].join("\n")),
        );
    return { flags: MessageFlags.IsComponentsV2 as const, components: [container], allowedMentions: { users: [memberId] } };
}
