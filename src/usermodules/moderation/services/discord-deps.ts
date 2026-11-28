import {
    type Client,
    ComponentType,
    type Guild,
    type GuildMember,
    MessageFlags,
    PermissionFlagsBits,
    RESTJSONErrorCodes,
} from "discord.js";
import { cut } from "@/utils/format";
import { hierarchyRefusal, roleProblem } from "@/utils/member-hierarchy";
import { type CaseDiscord, GUILD_NOT_CACHED } from "./case.service";

/** Discord keeps at most 512 characters of an audit log reason. */
const AUDIT_REASON_MAX = 512;
const audit = (reason: string | undefined) => (reason === undefined ? undefined : cut(reason, AUDIT_REASON_MAX));

/** The bot's Discord side of a Case: every call goes through the guild's own managers. */
export function createDiscordDeps(client: Client): CaseDiscord {
    const guildOf = (guildId: string): Guild => {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) throw Object.assign(new Error(`Guild ${guildId} is not cached`), { code: GUILD_NOT_CACHED });
        return guild;
    };
    const memberOf = (guild: Guild, userId: string): Promise<GuildMember | null> => guild.members.fetch(userId).catch(() => null);
    const meOf = async (guild: Guild): Promise<GuildMember | null> => guild.members.me ?? (await memberOf(guild, client.user?.id ?? ""));

    return {
        timeout: async (guildId, userId, ms, reason) => {
            await guildOf(guildId).members.edit(userId, {
                communicationDisabledUntil: ms === null ? null : new Date(Date.now() + ms),
                reason: audit(reason),
            });
        },
        kick: async (guildId, userId, reason) => {
            await guildOf(guildId).members.kick(userId, audit(reason));
        },
        ban: async (guildId, userId, deleteSeconds, reason) => {
            await guildOf(guildId).members.ban(userId, { deleteMessageSeconds: deleteSeconds, reason: audit(reason) });
        },
        unban: async (guildId, userId) => {
            await guildOf(guildId).members.unban(userId);
        },
        addRole: async (guildId, userId, roleId) => {
            await guildOf(guildId).members.addRole({ user: userId, role: roleId });
        },
        removeRole: async (guildId, userId, roleId) => {
            await guildOf(guildId).members.removeRole({ user: userId, role: roleId });
        },
        dm: async (userId, payload) => {
            try {
                await (await client.users.fetch(userId)).send(payload);
                return null;
            } catch (err) {
                if ((err as { code?: number }).code !== RESTJSONErrorCodes.CannotSendMessagesToThisUser) {
                    return cut(err instanceof Error ? err.message : String(err), 80);
                }
                return client.guilds.cache.some((g) => g.members.cache.has(userId)) ? "DMs closed" : "Not in a shared server";
            }
        },
        postCaseChannel: async (channelId, payload) => {
            const channel = await client.channels.fetch(channelId);
            if (!channel?.isSendable()) throw new Error(`Case Channel ${channelId} is not sendable`);
            const sent = await channel.send(payload);
            return { channelId, messageId: sent.id };
        },
        removeButtons: async ({ channelId, messageId }) => {
            const channel = await client.channels.fetch(channelId);
            if (!channel?.isTextBased()) return;
            const message = await channel.messages.fetch(messageId);
            const containers = message.components.filter((c) => c.type === ComponentType.Container).map((c) => c.toJSON());
            await message.edit({ components: containers, flags: MessageFlags.IsComponentsV2 });
        },
        isMember: async (guildId, userId) => (await memberOf(guildOf(guildId), userId)) !== null,
        canAct: async (guildId, moderatorId, targetId, action) => {
            const guild = guildOf(guildId);
            const me = await meOf(guild);
            if (!me) return "I'm not in that server.";
            const actor = moderatorId ? await memberOf(guild, moderatorId) : null;
            if (moderatorId && !actor) return "You're not in that server.";
            const target = await memberOf(guild, targetId);
            const refusal = hierarchyRefusal({ ownerId: guild.ownerId, me, actor, targetId, target });
            if (refusal || !target || !action) return refusal;
            const botCan = action === "mute" ? target.moderatable : action === "kick" ? target.kickable : target.bannable;
            return botCan ? null : "I can't do that to this member, so check my permissions and my role position.";
        },
        canGiveRole: async (guildId, moderatorId, userId, roleId) => {
            const guild = guildOf(guildId);
            const me = await meOf(guild);
            const actor = await memberOf(guild, moderatorId);
            if (!me || !actor) return "I'm not in that server.";
            const role = guild.roles.cache.get(roleId) ?? (await guild.roles.fetch(roleId).catch(() => null));
            const problem = roleProblem(role, guildId, me.roles.highest.position, me.permissions.has(PermissionFlagsBits.ManageRoles));
            if (problem || !role) return problem;
            if (actor.id !== guild.ownerId && role.position >= actor.roles.highest.position)
                return "Your highest role is not above that role.";
            if ((await memberOf(guild, userId))?.roles.cache.has(roleId)) return "That member already has the role.";
            return null;
        },
        guildName: (guildId) => client.guilds.cache.get(guildId)?.name ?? "the server",
    };
}
