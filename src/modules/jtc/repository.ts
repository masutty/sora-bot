import { TTLCache } from "@/utils/cache";
import { query } from "../../database/connection";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface JtcConfig {
	channel_id: string;
}

export interface ActiveRoom {
	channel_id: string;
	guild_id: string;
	owner_id: string;
}

// ─── JTC Config (root channel per guild) ──────────────────────────────────────

const configCache = new TTLCache<string, string>(5 * 60 * 1000);

export async function getJtcConfig(guildId: string): Promise<string | null> {
	const cached = configCache.get(guildId);
	if (cached !== null) return cached;

	const result = await query<JtcConfig>(
		`SELECT channel_id FROM jtc_config WHERE guild_id = $1`,
		[guildId],
	);

	const channelId = result.rows[0]?.channel_id ?? null;
	if (channelId) configCache.set(guildId, channelId);
	return channelId;
}

export async function setJtcConfig(
	guildId: string,
	channelId: string,
): Promise<void> {
	await query(
		`INSERT INTO jtc_config (guild_id, channel_id)
     VALUES ($1, $2)
     ON CONFLICT (guild_id) DO UPDATE SET channel_id = $2`,
		[guildId, channelId],
	);
	configCache.set(guildId, channelId);
}

// ─── Custom Room Names (per user per guild) ────────────────────────────────────
// Room names rarely change — indefinite TTL (Map without expiry is fine here).

const nameCache = new TTLCache<string, string>(Infinity);

export async function getCustomRoomName(
	userId: string,
	guildId: string,
): Promise<string | null> {
	const key = `${guildId}:${userId}`;
	const cached = nameCache.get(key);
	if (cached !== null) return cached;

	const result = await query<{ room_name: string }>(
		`SELECT room_name FROM jtc_room_names WHERE user_id = $1 AND guild_id = $2`,
		[userId, guildId],
	);

	const name = result.rows[0]?.room_name ?? null;
	if (name) nameCache.set(key, name);
	return name;
}

export async function setCustomRoomName(
	userId: string,
	guildId: string,
	name: string,
): Promise<void> {
	await query(
		`INSERT INTO jtc_room_names (user_id, guild_id, room_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, guild_id) DO UPDATE SET room_name = $3`,
		[userId, guildId, name],
	);
	nameCache.set(`${guildId}:${userId}`, name);
}

// ─── Active Rooms (temp channels currently alive) ─────────────────────────────
// Persisted in DB so we can clean up orphaned channels after a bot restart.

export async function saveActiveRoom(
	channelId: string,
	guildId: string,
	ownerId: string,
): Promise<void> {
	await query(
		`INSERT INTO jtc_active_rooms (channel_id, guild_id, owner_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (channel_id) DO NOTHING`,
		[channelId, guildId, ownerId],
	);
}

export async function removeActiveRoom(channelId: string): Promise<void> {
	await query(`DELETE FROM jtc_active_rooms WHERE channel_id = $1`, [
		channelId,
	]);
}

export async function getAllActiveRooms(): Promise<ActiveRoom[]> {
	const result = await query<ActiveRoom>(
		`SELECT channel_id, guild_id, owner_id FROM jtc_active_rooms`,
	);
	return result.rows;
}
