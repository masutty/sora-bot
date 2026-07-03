import { ChannelType, SlashCommandBuilder } from "discord.js";
import { defineCommand, defineModule } from "@/define";
import { handleVoiceStateUpdate, restoreActiveRooms } from "./handler";
import { setCustomRoomName, setJtcConfig } from "./repository";
import { CommandCategory } from "@/types";
import { Logger } from "@/utils/logging";

const logger = new Logger("jtc.index")

// ─── Schema ────────────────────────────────────────────────────────────────────

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS jtc_config (
    guild_id    VARCHAR(20) PRIMARY KEY REFERENCES guilds(id) ON DELETE CASCADE,
    channel_id  VARCHAR(20) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS jtc_room_names (
    user_id     VARCHAR(20) NOT NULL,
    guild_id    VARCHAR(20) NOT NULL,
    room_name   VARCHAR(100) NOT NULL,
    PRIMARY KEY (user_id, guild_id)
  );

  CREATE TABLE IF NOT EXISTS jtc_active_rooms (
    channel_id  VARCHAR(20) PRIMARY KEY,
    guild_id    VARCHAR(20) NOT NULL,
    owner_id    VARCHAR(20) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

// ─── Commands ──────────────────────────────────────────────────────────────────

const jtcSetCommand = defineCommand({
	name: "jtc-set",
	description: "Defines the join-to-create voice channel root.",
	category: CommandCategory.ADMIN,
	adminOnly: true,
	args: [
		{
			name: "channel",
			type: "channel",
			required: true,
			description: "JTC Root Channel",
		},
	],

	slashBuilder: new SlashCommandBuilder()
		.setName("jtc-set")
		.setDescription("Defines the join-to-create voice channel root.")
		.addChannelOption((opt) =>
			opt
				.setName("channel")
				.setDescription("JTC Root channel")
				.setRequired(true)
				.addChannelTypes(ChannelType.GuildVoice),
		),

	async execute(ctx) {
        logger.debug(`Execution context: ${Logger.stringify(ctx)}`)
		if (!ctx.guild) {
			await ctx.reply({ content: "Servers only!", ephemeral: true });
			return;
		}

		const channel = ctx.args.getChannel("channel");
		if (!channel?.isVoiceBased()) {
			await ctx.reply({
				content: "❌ You need to specify a valid voice channel.",
				ephemeral: true,
			});
			return;
		}

		await setJtcConfig(ctx.guild.id, channel.id);
		await ctx.reply({ content: `✅ Defined root channel: **${channel.name}**` });
	},
});

const jtcSetRoomNameCommand = defineCommand({
	name: "jtc-setroomname",
	description: "Defines the join-to-create room name for a specific user",
	category: CommandCategory.ADMIN,
	adminOnly: true,
	args: [
		{
			name: "user",
			type: "user",
			required: true,
			description: "Target user",
		},
		{
			name: "room_name",
			type: "string",
			required: true,
			description: "Room name (max. 100 chars)",
		},
	],

	async execute(ctx) {
        logger.debug(`Execution context: ${Logger.stringify(ctx)}`)
		if (!ctx.guild) {
			await ctx.reply({ content: "Only on servers!", ephemeral: true });
			return;
		}

		const user = ctx.args.getUser("user");
		if (!user) {
			await ctx.reply({
				content: "❌ User not found. Use @mention or ID.",
				ephemeral: true,
			});
			return;
		}

		const room_name = ctx.args.getString("room_name")!;
        if (!room_name) {
            await ctx.reply({
                content: "❌ Room name required.",
                ephemeral: true,
            });
            return;
        }
		if (room_name.length > 100) {
			await ctx.reply({
				content: "❌ This name is too long! (max. 100 characters)",
				ephemeral: true,
			});
			return;
		}

		await setCustomRoomName(user.id, ctx.guild.id, room_name);
		await ctx.reply({
			content: `✅ **<@${user.id}>**'s room will be named **"${room_name}"**`,
		});
	},
});

// ─── Module ────────────────────────────────────────────────────────────────────

export default defineModule({
	name: "jtc",
	description:
		"Join-to-Create: Create temporary voice channels.",
	authors: [{ name: "masutty", id: 188851299255713792n }],

	migrations: [SCHEMA],

	commands: [jtcSetCommand, jtcSetRoomNameCommand],

	events: {
		async voiceStateUpdate(client, oldState, newState) {
            logger.debug(`Voice state update detected`)
            logger.debug("Previous: " + JSON.stringify(oldState));
            logger.debug("New: " + JSON.stringify(newState));
			// await handleVoiceStateUpdate(client, oldState, newState);
		},
	},

	async onReady(client) {
		await restoreActiveRooms(client);
	},
});
