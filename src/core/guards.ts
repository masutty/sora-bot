import { PermissionFlagsBits } from "discord.js";
import type { GuildMember, User } from "discord.js";
import { config } from "../config";
import type { CommandDefinition } from "../types";

interface GuardContext {
    user: User;
    member: GuildMember | null;
}

export async function checkGuards(
    ctx: GuardContext,
    cmd: CommandDefinition,
): Promise<string | null> {
    if (cmd.botOwnerOnly && !config.bot.ownerIds.includes(ctx.user.id)) {
        return "This command is restricted to my developers!";
    }

    if (cmd.allowedUsers?.length && !cmd.allowedUsers.includes(ctx.user.id)) {
        return "You don't have permission to run this command!";
    }

    if (cmd.adminOnly && !ctx.member?.permissions.has(PermissionFlagsBits.Administrator)) {
        return "This command requires administrator permission!";
    }

    if (cmd.permissions?.length) {
        for (const perm of cmd.permissions) {
            if (!ctx.member?.permissions.has(perm)) {
                return "You don't have the required permissions to run this command.";
            }
        }
    }

    const requiredPerms = cmd.options?.toJSON().default_member_permissions;
    if (requiredPerms && !ctx.member?.permissions.has(BigInt(requiredPerms))) {
        return "You don't have permission to use this command.";
    }

    return null;
}
