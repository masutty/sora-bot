import { query } from "@/database/connection";
import { TTLCache } from "@/utils/cache";
import { ALL_FLAGS, FLAG_DEFINITIONS, type FlagName } from "../types";
import { getOrCreateGuildConfig } from "./guilds";

const flagsCache = new TTLCache<string, Record<FlagName, boolean>>(60 * 1000);

export async function getGuildFlags(guildId: string): Promise<Record<FlagName, boolean>> {
    const cached = flagsCache.get(guildId);
    if (cached) return cached;

    const result = await query<{ flag_name: FlagName; enabled: boolean }>(
        `SELECT flag_name, enabled FROM bh_guild_flags WHERE guild_id = $1`,
        [guildId],
    );
    const overrides = new Map(result.rows.map((r) => [r.flag_name, r.enabled]));

    const flags = {} as Record<FlagName, boolean>;
    for (const name of ALL_FLAGS) {
        flags[name] = overrides.get(name) ?? FLAG_DEFINITIONS[name].default;
    }

    flagsCache.set(guildId, flags);
    return flags;
}

export async function isFlagEnabled(guildId: string, flag: FlagName): Promise<boolean> {
    const flags = await getGuildFlags(guildId);
    return flags[flag];
}

export async function setGuildFlag(guildId: string, flag: FlagName, enabled: boolean): Promise<void> {
    await getOrCreateGuildConfig(guildId);
    await query(
        `INSERT INTO bh_guild_flags (guild_id, flag_name, enabled)
         VALUES ($1, $2, $3)
         ON CONFLICT (guild_id, flag_name) DO UPDATE SET enabled = $3, updated_at = NOW()`,
        [guildId, flag, enabled],
    );
    flagsCache.delete(guildId);
}
