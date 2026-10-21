import { query } from "@/database/connection";
import { TTLCache } from "@/utils/cache";

/** Read on hot paths (every rare find opens a vote), so cached - wrapped so a missing key caches too. A write clears its key. */
const settingsCache = new TTLCache<string, { value: string | null }>(60 * 1000);

/** A bot-wide setting an owner changed at runtime (`bh_bot_settings`), or `null` when it was never set. */
export async function getBotSetting(key: string): Promise<string | null> {
    const cached = settingsCache.get(key);
    if (cached) return cached.value;

    const result = await query<{ value: string }>(`SELECT value FROM bh_bot_settings WHERE key = $1`, [key]);
    const value = result.rows[0]?.value ?? null;
    settingsCache.set(key, { value });
    return value;
}

export async function setBotSetting(key: string, value: string): Promise<void> {
    await query(
        `INSERT INTO bh_bot_settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        [key, value],
    );
    settingsCache.delete(key);
}
