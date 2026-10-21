import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import { openMemberAdmin, resolveTargetMember } from "../views/member-admin.open";

/** Right-click a user, then Apps, then "Manage member": the same panel as `/admin member`. */
export default defineCommand({
    name: "Manage member",
    description: "Manage one member: profile, biomes, badges, sessions, channel.",
    category: CommandCategory.ADMIN,
    contextMenu: "user",
    showOnHelp: false,
    adminOnly: true,
    guildOnly: true,

    async run(ctx) {
        await openMemberAdmin(ctx, ctx.guild, await resolveTargetMember(ctx.args));
    },
});
