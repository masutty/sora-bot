// import { EmbedBuilder, Events, type GuildMember } from "discord.js";
// import { defineCommand, defineModule } from "@/define";
// import { query } from "../../database/connection";
// import { CommandCategory } from "@/types";

// const WELCOME_SCHEMA = `
//   CREATE TABLE IF NOT EXISTS welcome_configs (
//     guild_id    VARCHAR(20)  PRIMARY KEY REFERENCES guilds(id) ON DELETE CASCADE,
//     channel_id  VARCHAR(20),
//     message     TEXT         NOT NULL DEFAULT 'Bem-vindo(a) ao servidor, {user}!',
//     enabled     BOOLEAN      NOT NULL DEFAULT true,
//     created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
//   );
// `;

// export default defineModule({
// 	name: "welcome",
// 	description: "Sends a welcome message when a member joins!",
// 	authors: [{ name: "masutty", id: 188851299255713792n }],

// 	migrations: [WELCOME_SCHEMA],

// 	commands: [
// 		defineCommand({
// 			name: "welcome-config",
// 			description: "Configures the welcome message",
// 			category: CommandCategory.ADMIN,
// 			adminOnly: true,

// 			async execute(ctx) {
// 				await ctx.reply({
// 					content: "⚙️ Use subcommands to configure (TODO)",
// 					ephemeral: true,
// 				});
// 			},
// 		}),
// 	],

// 	events: [
// 		{
// 			event: Events.GuildMemberAdd,
// 			async handler(_client, member: GuildMember) {
// 				const result = await query<{
// 					channel_id: string;
// 					message: string;
// 					enabled: boolean;
// 				}>(
// 					`SELECT channel_id, message, enabled FROM welcome_configs WHERE guild_id = $1`,
// 					[member.guild.id],
// 				);

// 				const cfg = result.rows[0];
// 				if (!cfg?.enabled || !cfg.channel_id) return;

// 				const channel = member.guild.channels.cache.get(cfg.channel_id);
// 				if (!channel?.isTextBased()) return;

// 				const text = cfg.message.replace("{user}", `<@${member.id}>`);
// 				await channel.send({
// 					embeds: [
// 						new EmbedBuilder()
// 							.setColor(0x57f287)
// 							.setDescription(`👋 ${text}`)
// 							.setThumbnail(member.user.displayAvatarURL()),
// 					],
// 				});
// 			},
// 		},
// 	],

// 	async onReady(client) {
// 		// Chamado quando o bot está online e pronto
// 		void client; // remove unused warning
// 	},
// });
