import { FLAG_DEFINITIONS } from "../constants/flags.constants";
import { setGuildFlag } from "../repository/flags.repository";
import type { FlagName } from "../types";

export async function setFlag(guildId: string, flag: FlagName, enabled: boolean): Promise<string> {
    await setGuildFlag(guildId, flag, enabled);
    return `${FLAG_DEFINITIONS[flag].label} is now ${enabled ? "ON" : "OFF"}.`;
}
