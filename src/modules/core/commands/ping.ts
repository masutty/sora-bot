import { EmbedBuilder } from "discord.js";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";

export default defineCommand({
	name: "ping",
	description: "Checks bot latency.",
	category: CommandCategory.UTILITY,

	async execute(ctx) {
		const sent = await ctx.reply({ content: "Calculating..." });
		const roundtrip = sent.createdTimestamp - ctx.createdTimestamp;
		await ctx.editReply({
			content: "",
			embeds: [buildEmbed(roundtrip, ctx.client.ws.ping)],
		});
	},
});

function buildEmbed(roundtrip: number, ws: number): EmbedBuilder {
	return new EmbedBuilder()
		.setColor(0x5865f2)
		.setTitle("🏓 Pong!")
		.addFields(
			{ name: "Roundtrip", value: `${roundtrip}ms`, inline: true },
			{ name: "WebSocket", value: `${ws}ms`, inline: true },
		);
}
