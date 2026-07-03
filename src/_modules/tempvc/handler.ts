import { ChannelType, type VoiceState } from "discord.js";
import { Logger } from "@/utils/logging";
import type { BotClient } from "../../core/BotClient";
import {
	getCustomRoomName,
	getJtcConfig,
	removeActiveRoom,
	saveActiveRoom,
} from "./repository";

const logger = new Logger("jtc.handler");

// In-memory set for O(1) lookup on every VoiceStateUpdate
export const activeRooms = new Map<string, string>(); // channelId → ownerId

// ─── Main Handler ──────────────────────────────────────────────────────────────

export async function handleVoiceStateUpdate(
	client: BotClient,
	oldState: VoiceState,
	newState: VoiceState,
): Promise<void> {
	await Promise.all([handleJoin(newState), handleLeave(oldState)]);
}

// ─── User joined a voice channel ──────────────────────────────────────────────

async function handleJoin(state: VoiceState): Promise<void> {
	if (!state.channelId || !state.member) return;

	const jtcRoot = await getJtcConfig(state.guild.id);
	if (!jtcRoot || state.channelId !== jtcRoot) return;

	const rootChannel = state.guild.channels.cache.get(jtcRoot);
	if (!rootChannel?.isVoiceBased()) return;

	const member = state.member;
	const customName = await getCustomRoomName(member.id, state.guild.id);
	const roomName = customName ?? `${member.displayName}'s room`;

	let tempChannel;
	try {
		tempChannel = await state.guild.channels.create({
			name: roomName,
			type: ChannelType.GuildVoice,
			parent: rootChannel.parentId,
			bitrate: rootChannel.bitrate,
			userLimit: rootChannel.userLimit,
			permissionOverwrites: rootChannel.permissionOverwrites.cache.toJSON(),
		});
	} catch (err) {
		logger.error(err instanceof Error ? err : new Error(String(err)), {
			guild: state.guild.id,
		});
		return;
	}

	try {
		await member.voice.setChannel(tempChannel);
	} catch (err) {
		// User left before we could move them — clean up the channel we created
		logger.warn(
			`Failed to move ${member.displayName} - destroying channel`,
			{ channel: tempChannel.id },
		);
		await tempChannel.delete().catch(() => {});
		return;
	}

	activeRooms.set(tempChannel.id, member.id);
	await saveActiveRoom(tempChannel.id, state.guild.id, member.id);
	logger.info(`Room created: "${roomName}" for ${member.displayName}`);
}

// ─── User left a voice channel ────────────────────────────────────────────────

async function handleLeave(state: VoiceState): Promise<void> {
	if (!state.channelId) return;
	if (!activeRooms.has(state.channelId)) return;

	const channel = state.guild.channels.cache.get(state.channelId);

	// Only delete when the channel is empty
	if (channel?.isVoiceBased() && channel.members.size > 0) return;

	activeRooms.delete(state.channelId);
	await removeActiveRoom(state.channelId);

	if (channel) {
		await channel.delete().catch((err: unknown) => {
			logger.warn(`Failed to destroy room ${state.channelId}`, {
				err: String(err),
			});
		});
		logger.info(`Room destroyed: "${channel.name}"`);
	}
}

// ─── Startup cleanup ──────────────────────────────────────────────────────────
// After a restart, some rooms may have been left in the DB but are now empty or
// no longer exist. We clean those up and restore the ones still active.

export async function restoreActiveRooms(client: BotClient): Promise<void> {
	const { getAllActiveRooms } = await import("./repository");
	const rooms = await getAllActiveRooms();

	for (const room of rooms) {
		const guild = client.guilds.cache.get(room.guild_id);
		const channel = guild?.channels.cache.get(room.channel_id);

		if (!channel || (channel.isVoiceBased() && channel.members.size === 0)) {
			await channel?.delete().catch(() => {});
			await removeActiveRoom(room.channel_id);
		} else {
			// Still has members — restore to memory
			activeRooms.set(room.channel_id, room.owner_id);
		}
	}

	if (rooms.length > 0) {
		logger.info(`Restart cleanup: ${rooms.length} rooms verified.`);
	}
}
