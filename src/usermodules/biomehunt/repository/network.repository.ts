import { query } from "@/database/connection";
import type { NetworkBanKind, NetworkGuildRow, NetworkPingRow, NetworkStatus } from "../types";

export async function getNetworkGuild(guildId: string): Promise<NetworkGuildRow | null> {
    const result = await query<NetworkGuildRow>(`SELECT * FROM bh_network_guilds WHERE guild_id = $1`, [guildId]);
    return result.rows[0] ?? null;
}

/** Creates the guild's Network row (status `none`) if missing. The guild must already have a `bh_guilds` row. */
export async function ensureNetworkGuild(guildId: string): Promise<NetworkGuildRow> {
    const result = await query<NetworkGuildRow>(
        `INSERT INTO bh_network_guilds (guild_id) VALUES ($1)
         ON CONFLICT (guild_id) DO UPDATE SET guild_id = EXCLUDED.guild_id
         RETURNING *`,
        [guildId],
    );
    return result.rows[0];
}

export interface NetworkConfigPatch {
    networkChannelId?: string | null;
    staffChannelId?: string | null;
    staffRoleId?: string | null;
    announceRoleId?: string | null;
    inviteUrl?: string | null;
}

const PATCH_COLUMNS: Record<keyof NetworkConfigPatch, string> = {
    networkChannelId: "network_channel_id",
    staffChannelId: "staff_channel_id",
    staffRoleId: "staff_role_id",
    announceRoleId: "announce_role_id",
    inviteUrl: "invite_url",
};

/** Writes only the keys present in `patch` - an absent key keeps its value, an explicit `null` clears it. */
export async function updateNetworkConfig(guildId: string, patch: NetworkConfigPatch): Promise<void> {
    const keys = (Object.keys(patch) as Array<keyof NetworkConfigPatch>).filter((k) => patch[k] !== undefined);
    if (keys.length === 0) return;
    const sets = keys.map((k, i) => `${PATCH_COLUMNS[k]} = $${i + 2}`);
    await query(`UPDATE bh_network_guilds SET ${sets.join(", ")}, updated_at = NOW() WHERE guild_id = $1`, [
        guildId,
        ...keys.map((k) => patch[k]),
    ]);
}

export interface StatusTransitionFields {
    forced?: boolean;
    decidedBy?: string | null;
}

/**
 * Compare-and-set status change: only applies if the CURRENT status is one of `from`, and returns
 * the updated row - `null` means someone else moved it first (a second owner click, a leave racing
 * an approval), and the caller must treat it as a no-op. Stamps `requested_at` on `pending`,
 * `approved_at` on `member`, and clears `approved_at` on `none`.
 */
export async function transitionNetworkStatus(
    guildId: string,
    from: NetworkStatus[],
    to: NetworkStatus,
    fields: StatusTransitionFields = {},
): Promise<NetworkGuildRow | null> {
    const result = await query<NetworkGuildRow>(
        `UPDATE bh_network_guilds
            SET status = $3::varchar,
                forced = COALESCE($4, forced),
                decided_by = COALESCE($5, decided_by),
                requested_at = CASE WHEN $3::varchar = 'pending' THEN NOW() ELSE requested_at END,
                approved_at = CASE WHEN $3::varchar = 'member' THEN NOW() WHEN $3::varchar = 'none' THEN NULL ELSE approved_at END,
                updated_at = NOW()
          WHERE guild_id = $1 AND status = ANY($2::varchar[])
          RETURNING *`,
        [guildId, from, to, fields.forced ?? null, fields.decidedBy ?? null],
    );
    return result.rows[0] ?? null;
}

export async function getNetworkPings(guildId: string): Promise<NetworkPingRow[]> {
    const result = await query<NetworkPingRow>(`SELECT * FROM bh_network_pings WHERE guild_id = $1 ORDER BY biome`, [guildId]);
    return result.rows;
}

/** `roleId = null` removes the ping for that biome. */
export async function setNetworkPing(guildId: string, biome: string, roleId: string | null): Promise<void> {
    if (roleId === null) {
        await query(`DELETE FROM bh_network_pings WHERE guild_id = $1 AND biome = $2`, [guildId, biome]);
        return;
    }
    await query(
        `INSERT INTO bh_network_pings (guild_id, biome, role_id) VALUES ($1, $2, $3)
         ON CONFLICT (guild_id, biome) DO UPDATE SET role_id = $3`,
        [guildId, biome, roleId],
    );
}

export async function isNetworkBanned(kind: NetworkBanKind, targetId: string): Promise<boolean> {
    const result = await query(`SELECT 1 FROM bh_network_bans WHERE kind = $1 AND target_id = $2`, [kind, targetId]);
    return (result.rowCount ?? 0) > 0;
}

/** `false` if it was already banned. */
export async function addNetworkBan(kind: NetworkBanKind, targetId: string, bannedBy: string, reason: string | null): Promise<boolean> {
    const result = await query(
        `INSERT INTO bh_network_bans (kind, target_id, banned_by, reason) VALUES ($1, $2, $3, $4)
         ON CONFLICT (kind, target_id) DO NOTHING`,
        [kind, targetId, bannedBy, reason],
    );
    return (result.rowCount ?? 0) > 0;
}

export async function removeNetworkBan(kind: NetworkBanKind, targetId: string): Promise<boolean> {
    const result = await query(`DELETE FROM bh_network_bans WHERE kind = $1 AND target_id = $2`, [kind, targetId]);
    return (result.rowCount ?? 0) > 0;
}

/** `false` if the member was already excluded. The guild must already have a `bh_guilds` row. */
export async function addNetworkExclusion(guildId: string, discordUserId: string, excludedBy: string): Promise<boolean> {
    const result = await query(
        `INSERT INTO bh_network_exclusions (guild_id, discord_user_id, excluded_by) VALUES ($1, $2, $3)
         ON CONFLICT (guild_id, discord_user_id) DO NOTHING`,
        [guildId, discordUserId, excludedBy],
    );
    return (result.rowCount ?? 0) > 0;
}

export async function removeNetworkExclusion(guildId: string, discordUserId: string): Promise<boolean> {
    const result = await query(`DELETE FROM bh_network_exclusions WHERE guild_id = $1 AND discord_user_id = $2`, [guildId, discordUserId]);
    return (result.rowCount ?? 0) > 0;
}

export async function getMemberNetworkGuilds(): Promise<NetworkGuildRow[]> {
    const result = await query<NetworkGuildRow>(`SELECT * FROM bh_network_guilds WHERE status = 'member'`);
    return result.rows;
}

export async function isNetworkExcluded(guildId: string, discordUserId: string): Promise<boolean> {
    const result = await query(`SELECT 1 FROM bh_network_exclusions WHERE guild_id = $1 AND discord_user_id = $2`, [
        guildId,
        discordUserId,
    ]);
    return (result.rowCount ?? 0) > 0;
}

/** guild_id → ping role for one biome, across every guild that set one. */
export async function getNetworkPingRolesForBiome(biome: string): Promise<Map<string, string>> {
    const result = await query<NetworkPingRow>(`SELECT * FROM bh_network_pings WHERE biome = $1`, [biome]);
    return new Map(result.rows.map((r) => [r.guild_id, r.role_id]));
}

/** Records one daily activity check: the UTC date it ran (`YYYY-MM-DD`) and the new below-minimum streak. */
export async function recordActivityCheck(guildId: string, checkedOn: string, lowChecks: number): Promise<void> {
    await query(`UPDATE bh_network_guilds SET last_activity_check = $2::date, low_activity_checks = $3 WHERE guild_id = $1`, [
        guildId,
        checkedOn,
        lowChecks,
    ]);
}
