import type { Guild, GuildMember } from "discord.js";
import type { CommandArgs, CommandContext } from "@/define";
import { UserFacingError } from "@/define";
import { EmbedFormatter, NO_PINGS } from "@/utils/format";
import { defaultMemberAdminDeps, memberAdminView } from "./member-admin.view";

/** The clicked or picked user as a guild member - `null` when they are not in this server. */
export async function resolveTargetMember(args: CommandArgs, name = "user"): Promise<GuildMember | null> {
    try {
        return await args.getMember(name);
    } catch (err) {
        if (err instanceof UserFacingError) return null;
        throw err;
    }
}

/**
 * Opens the Member panel for `member`, or says the user is not in this server.
 * Shared by `/bh-admin member` and the "Manage member" user context menu.
 */
export async function openMemberAdmin(ctx: CommandContext, guild: Guild, member: GuildMember | null): Promise<void> {
    if (!member) {
        await ctx.defer({ ephemeral: true });
        await ctx.reply({ ...EmbedFormatter.info("That user isn't in this server."), allowedMentions: NO_PINGS });
        return;
    }
    await ctx.defer();
    await ctx.open(memberAdminView(member, defaultMemberAdminDeps(ctx.client, guild, member)), undefined);
}
