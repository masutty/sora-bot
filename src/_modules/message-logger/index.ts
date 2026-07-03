import { defineModule } from "@/define";
import { Logger } from "@/utils/logging";

const logger = new Logger("message-logger");

export default defineModule({
	name: "message-logger",
	description: "Logs all server messages to the console.",
    authors: [{ name: "masutty", id: 188851299255713792n }],

	events: {
		messageCreate(_client, message) {
			if (message.author.bot) return;

			const guild = message.guild?.name ?? "DM";
			const channel = "name" in message.channel ? `#${message.channel.name}` : message.channel.id;

			logger.debug(`[${guild}] [${channel}] ${message.author.username}: ${message.content}`);
		},
	},
});
