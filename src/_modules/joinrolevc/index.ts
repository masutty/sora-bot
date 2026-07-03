import { defineModule } from "@/define";
import { Logger } from "@/utils/logging";

const logger = new Logger("joinrole.index");

export default defineModule({
    name: "joinrolevc",
    description: "Gives you a role if you join a voice channel.",
    authors: [{ name: "masutty", id: 188851299255713792n }],

    events: {

        // hook onto the voice channel states, so we detect if someone joins/leaves a vc
        async voiceStateUpdate(_client, oldState, newState) {
            const member = newState.member ?? oldState.member;
            if (!member) return; // no user somehow

            // JOIN voice channel
            if (!oldState.channelId && newState.channelId) {
                logger.debug("User joined voice channel");

                const roleId = "1502817511572246659";

                const hasRole = member.roles.cache.has(roleId);

                if (!hasRole) {
                    await member.roles.add(roleId).catch(err => {
                        logger.error(`Failed to add role ${roleId} to user ${member.id}:`, err);
                    });
                } else {
                    logger.debug(`User already has role ${roleId}`);
                }
            }

            // LEAVE voice channel (opcional)
            if (oldState.channelId && !newState.channelId) {
                logger.debug("User left voice channel");
                // maybe take the role if the member leaves or smt like that, wont do it but its possible
            }
        }

        // messageCreate(_client, message) {
        //     if (message.author.bot) return;

        //     const guild = message.guild?.name ?? "DM";
        //     const channel = "name" in message.channel ? `#${message.channel.name}` : message.channel.id;

        //     logger.debug(`[${guild}] [${channel}] ${message.author.username}: ${message.content}`);
        // },
    },
});
