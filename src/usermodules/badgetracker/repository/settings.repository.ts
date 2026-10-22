import { query } from "@/database/connection";
import type { TrackerSettingsRow } from "../types";

export async function getTrackerSettings(): Promise<TrackerSettingsRow> {
    await query(`INSERT INTO bt_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
    const result = await query<TrackerSettingsRow>(`SELECT interval_minutes, last_round_at FROM bt_settings WHERE id = 1`);
    return result.rows[0] as TrackerSettingsRow;
}

export async function setIntervalMinutes(n: number): Promise<void> {
    await query(
        `INSERT INTO bt_settings (id, interval_minutes) VALUES (1, $1)
         ON CONFLICT (id) DO UPDATE SET interval_minutes = $1`,
        [n],
    );
}

export async function setLastRoundAt(at: Date): Promise<void> {
    await query(
        `INSERT INTO bt_settings (id, last_round_at) VALUES (1, $1)
         ON CONFLICT (id) DO UPDATE SET last_round_at = $1`,
        [at],
    );
}
