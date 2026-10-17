import { query, transaction } from "@/database/connection";
import { type BiomeEntry, type BiomeMeta, DEFAULT_BIOMES, setBiomeRegistry } from "../constants/biomes.constants";
import type { BiomeCategory } from "../types";

interface BiomeRow {
    biome: string;
    label: string;
    category: BiomeCategory;
    color: number;
    flavor_text: string | null;
    icon_url: string | null;
    ansi_color: string | null;
    enabled: boolean;
}

function toEntry(row: BiomeRow): BiomeEntry {
    return {
        key: row.biome,
        label: row.label,
        category: row.category,
        color: row.color,
        flavorText: row.flavor_text ?? undefined,
        iconUrl: row.icon_url ?? undefined,
        ansiColor: row.ansi_color ?? undefined,
        enabled: row.enabled,
    };
}

/** Inserts every `DEFAULT_BIOMES` key missing from `bh_biomes` - never overwrites a row already there. */
export async function seedDefaultBiomes(): Promise<void> {
    const rows = Object.entries(DEFAULT_BIOMES).map(([biome, meta], i) => ({
        biome,
        label: meta.label,
        category: meta.category,
        color: meta.color,
        flavor_text: meta.flavorText || null,
        icon_url: meta.iconUrl || null,
        ansi_color: meta.ansiColor || null,
        sort_order: i,
    }));
    await query(
        `INSERT INTO bh_biomes (biome, label, category, color, flavor_text, icon_url, ansi_color, sort_order)
         SELECT biome, label, category, color, flavor_text, icon_url, ansi_color, sort_order
         FROM jsonb_to_recordset($1::jsonb) AS x(
             biome TEXT, label TEXT, category TEXT, color INTEGER,
             flavor_text TEXT, icon_url TEXT, ansi_color TEXT, sort_order INTEGER
         )
         ON CONFLICT (biome) DO NOTHING`,
        [JSON.stringify(rows)],
    );
}

/** Reads `bh_biomes` into the in-memory registry every lookup reads (see `setBiomeRegistry`). */
export async function loadBiomeRegistry(): Promise<void> {
    const result = await query<BiomeRow>(
        `SELECT biome, label, category, color, flavor_text, icon_url, ansi_color, enabled
         FROM bh_biomes
         ORDER BY sort_order, biome`,
    );
    setBiomeRegistry(result.rows.map(toEntry));
}

/** Adds a new biome at the end of the list. Returns false if the key already exists. */
export async function insertBiome(key: string, meta: BiomeMeta): Promise<boolean> {
    const result = await query(
        `INSERT INTO bh_biomes (biome, label, category, color, flavor_text, icon_url, ansi_color, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM bh_biomes))
         ON CONFLICT (biome) DO NOTHING`,
        [key, meta.label, meta.category, meta.color, meta.flavorText || null, meta.iconUrl || null, meta.ansiColor || null],
    );
    return (result.rowCount ?? 0) > 0;
}

/** Overwrites every editable field of an existing biome. */
export async function updateBiome(key: string, meta: BiomeMeta): Promise<void> {
    await query(
        `UPDATE bh_biomes
         SET label = $2, category = $3, color = $4, flavor_text = $5, icon_url = $6, ansi_color = $7, updated_at = NOW()
         WHERE biome = $1`,
        [key, meta.label, meta.category, meta.color, meta.flavorText || null, meta.iconUrl || null, meta.ansiColor || null],
    );
}

export async function setBiomeEnabled(key: string, enabled: boolean): Promise<void> {
    await query(`UPDATE bh_biomes SET enabled = $2, updated_at = NOW() WHERE biome = $1`, [key, enabled]);
}

/** Writes the whole registry in one transaction - every entry upserted, `sort_order` = its position. Rows not given are left as they are. */
export async function saveAllBiomes(entries: BiomeEntry[]): Promise<void> {
    await transaction(async (client) => {
        for (const [i, e] of entries.entries()) {
            await client.query(
                `INSERT INTO bh_biomes (biome, label, category, color, flavor_text, icon_url, ansi_color, enabled, sort_order)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                 ON CONFLICT (biome) DO UPDATE SET
                     label = $2, category = $3, color = $4, flavor_text = $5, icon_url = $6, ansi_color = $7,
                     enabled = $8, sort_order = $9, updated_at = NOW()`,
                [e.key, e.label, e.category, e.color, e.flavorText || null, e.iconUrl || null, e.ansiColor || null, e.enabled, i],
            );
        }
    });
}
