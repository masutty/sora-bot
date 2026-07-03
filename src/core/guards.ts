import { PermissionFlagsBits } from "discord.js";
import { config } from "../config";
import type { CommandDefinition } from "../types";
import type { CommandContext } from "./context";

export async function checkGuards(
	ctx: CommandContext,
	cmd: CommandDefinition,
): Promise<string | null> {
	if (cmd.ownerOnly && !config.bot.ownerIds.includes(ctx.user.id)) {
		return "This command is restricted to my developers!";
	}

	if (cmd.allowedUsers?.length && !cmd.allowedUsers.includes(ctx.user.id)) {
		return "You don' have permission to run this command!";
	}

	if (
		cmd.adminOnly &&
		!ctx.member?.permissions.has(PermissionFlagsBits.Administrator)
	) {
		return "This command requires administrator permission!";
	}

	if (cmd.permissions?.length) {
		for (const perm of cmd.permissions) {
			if (!ctx.member?.permissions.has(perm)) {
				return "You don't have the required permissions to run this command.";
			}
		}
	}

	return null;
}
