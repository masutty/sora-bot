import { ContainerBuilder } from "discord.js";
import { getGuildFlags, setGuildFlag } from "../repository/flags";
import { ALL_FLAGS, FLAG_DEFINITIONS, type FlagName } from "../types";

export async function flagSetAction(guildId: string, flag: FlagName, enabled: boolean): Promise<string> {
    await setGuildFlag(guildId, flag, enabled);
    return `${FLAG_DEFINITIONS[flag].label} is now ${enabled ? "ON" : "OFF"}.`;
}

export async function flagListAction(guildId: string): Promise<ContainerBuilder> {
    const flags = await getGuildFlags(guildId);

    const lines = ALL_FLAGS.map((name) => {
        const def = FLAG_DEFINITIONS[name];
        const state = flags[name] ? "✅ ON" : "❌ OFF";
        return `**${name}** - ${state} (default: ${def.default ? "ON" : "OFF"})\n-# ${def.description}`;
    });

    const container = new ContainerBuilder().setAccentColor(0x5865f2);
    container.addTextDisplayComponents((td) => td.setContent(`**Flags**\n${lines.join("\n\n")}`));
    return container;
}
