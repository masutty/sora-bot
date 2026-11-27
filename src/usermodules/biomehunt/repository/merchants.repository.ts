import { query } from "@/database/connection";
import { DEFAULT_MERCHANTS, type MerchantMeta, setMerchantRegistry } from "../constants/merchants.constants";

interface MerchantRow {
    merchant: string;
    label: string;
    color: number;
    flavor_text: string | null;
    icon_url: string | null;
    emoji: string | null;
    enabled: boolean;
}

const params = (meta: MerchantMeta) => [meta.label, meta.color, meta.flavorText ?? null, meta.iconUrl ?? null, meta.emoji ?? null];

/** Adds a merchant at the end of the list. `false` if the key already exists. */
export async function insertMerchant(key: string, meta: MerchantMeta): Promise<boolean> {
    const result = await query(
        `INSERT INTO bh_merchants (merchant, label, color, flavor_text, icon_url, emoji, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM bh_merchants))
         ON CONFLICT (merchant) DO NOTHING`,
        [key, ...params(meta)],
    );
    return (result.rowCount ?? 0) > 0;
}

export async function updateMerchant(key: string, meta: MerchantMeta): Promise<void> {
    await query(
        `UPDATE bh_merchants SET label = $2, color = $3, flavor_text = $4, icon_url = $5, emoji = $6, updated_at = NOW()
         WHERE merchant = $1`,
        [key, ...params(meta)],
    );
}

export async function setMerchantEnabled(key: string, enabled: boolean): Promise<void> {
    await query(`UPDATE bh_merchants SET enabled = $2, updated_at = NOW() WHERE merchant = $1`, [key, enabled]);
}

export async function seedDefaultMerchants(): Promise<void> {
    for (const [key, meta] of Object.entries(DEFAULT_MERCHANTS)) await insertMerchant(key, meta);
}

/** Reads `bh_merchants` into the in-memory registry every lookup reads. */
export async function loadMerchantRegistry(): Promise<void> {
    const result = await query<MerchantRow>(`SELECT * FROM bh_merchants ORDER BY sort_order, merchant`);
    setMerchantRegistry(
        result.rows.map((r) => ({
            key: r.merchant,
            label: r.label,
            color: r.color,
            flavorText: r.flavor_text ?? undefined,
            iconUrl: r.icon_url ?? undefined,
            emoji: r.emoji ?? undefined,
            enabled: r.enabled,
        })),
    );
}
