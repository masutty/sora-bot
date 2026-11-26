import { query, transaction } from "@/database/connection";
import { settings } from "../settings";
import type { ModSettings, Threshold, ThresholdAction } from "../types";

type SettingsPatch = Partial<Omit<ModSettings, "guild_id">>;

const PATCH_COLUMNS = ["case_channel_id", "warn_expiry_days", "auto_enabled", "auto_undo", "appeal_line", "moderator_role_id"] as const;

export function defaultSettings(guildId: string): ModSettings {
    return {
        guild_id: guildId,
        case_channel_id: null,
        warn_expiry_days: settings.defaultWarnExpiryDays,
        auto_enabled: false,
        auto_undo: true,
        appeal_line: null,
        moderator_role_id: null,
    };
}

export async function getSettings(guildId: string): Promise<ModSettings> {
    const result = await query<ModSettings>(`SELECT * FROM mod_settings WHERE guild_id = $1`, [guildId]);
    return result.rows[0] ?? defaultSettings(guildId);
}

/** Upserts only the columns present in `patch`; `null` clears a column, `undefined` is skipped. */
export async function updateSettings(guildId: string, patch: SettingsPatch): Promise<ModSettings> {
    const columns = PATCH_COLUMNS.filter((column) => patch[column] !== undefined);
    if (columns.length === 0) return getSettings(guildId);
    const params: unknown[] = [guildId, ...columns.map((column) => patch[column])];
    const placeholders = columns.map((_, i) => `$${i + 2}`).join(", ");
    const sets = columns.map((column, i) => `${column} = $${i + 2}`).join(", ");
    const result = await query<ModSettings>(
        `INSERT INTO mod_settings (guild_id, ${columns.join(", ")}) VALUES ($1, ${placeholders})
         ON CONFLICT (guild_id) DO UPDATE SET ${sets} RETURNING *`,
        params,
    );
    return result.rows[0] as ModSettings;
}

interface ThresholdRow {
    warns: number;
    action: ThresholdAction | null;
    duration_s: number | null;
}

export async function getThresholds(guildId: string): Promise<Threshold[]> {
    const result = await query<ThresholdRow>(`SELECT warns, action, duration_s FROM mod_thresholds WHERE guild_id = $1 ORDER BY warns`, [
        guildId,
    ]);
    return result.rows.map((row) => ({ warns: row.warns, action: row.action, durationS: row.duration_s }));
}

/** Replaces the whole ladder in one transaction. */
export async function replaceThresholds(guildId: string, ladder: Threshold[]): Promise<void> {
    await transaction(async (client) => {
        await client.query(`DELETE FROM mod_thresholds WHERE guild_id = $1`, [guildId]);
        for (const threshold of ladder) {
            await client.query(`INSERT INTO mod_thresholds (guild_id, warns, action, duration_s) VALUES ($1, $2, $3, $4)`, [
                guildId,
                threshold.warns,
                threshold.action,
                threshold.durationS,
            ]);
        }
    });
}
