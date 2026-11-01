import { query, transaction } from "@/database/connection";
import type { Block, OptionRow, PanelRow } from "../types";

const MENU_COLUMNS = "id, guild_id, name, placeholder, blocks, channel_id, message_id";
const OPTION_COLUMNS = "id, panel_id, position, label, emoji, description, blocks";

export async function listPanels(guildId: string): Promise<PanelRow[]> {
    const { rows } = await query<PanelRow>(`SELECT ${MENU_COLUMNS} FROM ip_panels WHERE guild_id = $1 ORDER BY id`, [guildId]);
    return rows;
}

export async function getPanel(panelId: number): Promise<PanelRow | null> {
    const { rows } = await query<PanelRow>(`SELECT ${MENU_COLUMNS} FROM ip_panels WHERE id = $1`, [panelId]);
    return rows[0] ?? null;
}

export async function insertPanel(guildId: string, name: string, placeholder: string, blocks: Block[]): Promise<PanelRow> {
    const { rows } = await query<PanelRow>(
        `INSERT INTO ip_panels (guild_id, name, placeholder, blocks) VALUES ($1, $2, $3, $4::jsonb) RETURNING ${MENU_COLUMNS}`,
        [guildId, name, placeholder, JSON.stringify(blocks)],
    );
    return rows[0];
}

export interface PanelPatch {
    name?: string;
    placeholder?: string;
    blocks?: Block[];
    channel_id?: string | null;
    message_id?: string | null;
}

export async function updatePanel(panelId: number, patch: PanelPatch): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    const add = (column: string, value: unknown, cast = "") => {
        params.push(value);
        sets.push(`${column} = $${params.length}${cast}`);
    };
    if (patch.name !== undefined) add("name", patch.name);
    if (patch.placeholder !== undefined) add("placeholder", patch.placeholder);
    if (patch.blocks !== undefined) add("blocks", JSON.stringify(patch.blocks), "::jsonb");
    if (patch.channel_id !== undefined) add("channel_id", patch.channel_id);
    if (patch.message_id !== undefined) add("message_id", patch.message_id);
    if (sets.length === 0) return;
    params.push(panelId);
    await query(`UPDATE ip_panels SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
}

export async function deletePanel(panelId: number): Promise<void> {
    await query(`DELETE FROM ip_panels WHERE id = $1`, [panelId]);
}

export async function listOptions(panelId: number): Promise<OptionRow[]> {
    const { rows } = await query<OptionRow>(`SELECT ${OPTION_COLUMNS} FROM ip_options WHERE panel_id = $1 ORDER BY position, id`, [
        panelId,
    ]);
    return rows;
}

export interface OptionFields {
    label: string;
    emoji: string | null;
    description: string | null;
}

/** Appends the option at the end of the select. */
export async function insertOption(panelId: number, fields: OptionFields, blocks: Block[]): Promise<OptionRow> {
    const { rows } = await query<OptionRow>(
        `INSERT INTO ip_options (panel_id, position, label, emoji, description, blocks)
         VALUES ($1, COALESCE((SELECT MAX(position) + 1 FROM ip_options WHERE panel_id = $1), 0), $2, $3, $4, $5::jsonb)
         RETURNING ${OPTION_COLUMNS}`,
        [panelId, fields.label, fields.emoji, fields.description, JSON.stringify(blocks)],
    );
    return rows[0];
}

export async function updateOption(optionId: number, patch: Partial<OptionFields> & { blocks?: Block[] }): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    const add = (column: string, value: unknown, cast = "") => {
        params.push(value);
        sets.push(`${column} = $${params.length}${cast}`);
    };
    if (patch.label !== undefined) add("label", patch.label);
    if (patch.emoji !== undefined) add("emoji", patch.emoji);
    if (patch.description !== undefined) add("description", patch.description);
    if (patch.blocks !== undefined) add("blocks", JSON.stringify(patch.blocks), "::jsonb");
    if (sets.length === 0) return;
    params.push(optionId);
    await query(`UPDATE ip_options SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
}

/** Creates a panel and all its options in one go, so a failure never leaves half a panel behind. */
export async function importPanel(
    guildId: string,
    panel: { name: string; placeholder: string; blocks: Block[]; options: Array<OptionFields & { blocks: Block[] }> },
): Promise<PanelRow> {
    return transaction(async (client) => {
        const { rows } = await client.query<PanelRow>(
            `INSERT INTO ip_panels (guild_id, name, placeholder, blocks) VALUES ($1, $2, $3, $4::jsonb) RETURNING ${MENU_COLUMNS}`,
            [guildId, panel.name, panel.placeholder, JSON.stringify(panel.blocks)],
        );
        for (const [position, o] of panel.options.entries()) {
            await client.query(
                `INSERT INTO ip_options (panel_id, position, label, emoji, description, blocks) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
                [rows[0].id, position, o.label, o.emoji, o.description, JSON.stringify(o.blocks)],
            );
        }
        return rows[0];
    });
}

export async function deleteOption(optionId: number): Promise<void> {
    await query(`DELETE FROM ip_options WHERE id = $1`, [optionId]);
}

/** Swaps the option with its neighbour in the select. A no-op at either end. */
export async function moveOption(panelId: number, optionId: number, direction: "up" | "down"): Promise<void> {
    await transaction(async (client) => {
        const { rows } = await client.query<{ id: number }>(
            `SELECT id FROM ip_options WHERE panel_id = $1 ORDER BY position, id FOR UPDATE`,
            [panelId],
        );
        const ids = rows.map((r) => r.id);
        const from = ids.indexOf(optionId);
        const to = direction === "up" ? from - 1 : from + 1;
        if (from < 0 || to < 0 || to >= ids.length) return;
        [ids[from], ids[to]] = [ids[to], ids[from]];
        for (const [position, id] of ids.entries()) {
            await client.query(`UPDATE ip_options SET position = $1 WHERE id = $2`, [position, id]);
        }
    });
}
