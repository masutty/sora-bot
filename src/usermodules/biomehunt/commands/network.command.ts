import { PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { confirm, defineCommand, type GuildCommandContext } from "@/define";
import { CommandCategory } from "@/types";
import { EmbedFormatter } from "@/utils/format";
import { defaultNetworkConfigDeps, networkConfigFlow } from "../flows/network-config.flow";
import { getNetworkGuild, getNetworkPings } from "../repository/network.repository";
import { loadEligibility } from "../services/network-eligibility.service";
import {
    defaultMembershipDeps,
    ensureNetworkRow,
    excludeMember,
    includeMember,
    leaveNetwork,
    precheckJoin,
    submitJoinRequest,
} from "../services/network-membership.service";
import { BiomeHuntError, NetworkStatus } from "../types";
import { buildEligibilityContainer, buildStatusContainer, v2 } from "../views/network.view";

export default defineCommand({
    name: "network",
    description: "Join and manage this server's place in the Network.",
    category: CommandCategory.ADMIN,
    showOnHelp: true,
    adminOnly: true,
    guildOnly: true,
    onMissingSubcommand: "run",

    options: new SlashCommandBuilder()
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand((s) => s.setName("join").setDescription("Check eligibility, configure, and ask to join the Network."))
        .addSubcommand((s) => s.setName("config").setDescription("Change this server's Network settings."))
        .addSubcommand((s) => s.setName("status").setDescription("Show this server's Network status, requirements and settings."))
        .addSubcommand((s) => s.setName("leave").setDescription("Leave the Network."))
        .addSubcommand((s) =>
            s
                .setName("exclude")
                .setDescription("Stop a member's finds from being published to the Network (they stay local).")
                .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true)),
        )
        .addSubcommand((s) =>
            s
                .setName("include")
                .setDescription("Publish a previously excluded member's finds to the Network again.")
                .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true)),
        ),

    async run(ctx) {
        const sub = ctx.args.getSubcommand() ?? "status";
        await ctx.defer({ ephemeral: true });

        switch (sub) {
            case "join":
                return runJoin(ctx);
            case "config":
                return runConfig(ctx);
            case "leave":
                return runLeave(ctx);
            case "exclude":
            case "include":
                return runExclusion(ctx, sub);
            default:
                return runStatus(ctx);
        }
    },
});

async function runJoin(ctx: GuildCommandContext): Promise<void> {
    const deps = defaultMembershipDeps(ctx.client);
    const gaps = await precheckJoin(ctx.guild.id, deps);
    if (gaps.length > 0) {
        await ctx.reply(v2(buildEligibilityContainer(gaps)));
        return;
    }
    await ctx.open(
        networkConfigFlow(defaultNetworkConfigDeps(), ctx.guild.id, async (guildId) => {
            const result = await submitJoinRequest(guildId, deps);
            if (result.kind === "ineligible") return v2(buildEligibilityContainer(result.gaps));
            if (result.kind === "not_available")
                return EmbedFormatter.info("This server is already in the Network or waiting for approval.");
            return EmbedFormatter.success(
                "Join request sent! The bot owner will review it, and the result will be posted in your staff channel.",
            );
        }),
        undefined,
    );
}

async function runConfig(ctx: GuildCommandContext): Promise<void> {
    await ensureNetworkRow(ctx.guild.id, defaultMembershipDeps(ctx.client));
    await ctx.open(
        networkConfigFlow(defaultNetworkConfigDeps(), ctx.guild.id, async () => EmbedFormatter.success("Network settings saved.")),
        undefined,
    );
}

async function runStatus(ctx: GuildCommandContext): Promise<void> {
    const [row, report, pings] = await Promise.all([
        getNetworkGuild(ctx.guild.id),
        loadEligibility(ctx.guild.id),
        getNetworkPings(ctx.guild.id),
    ]);
    await ctx.reply(v2(buildStatusContainer({ row, gaps: report.gaps, card: report.card, pings })));
}

async function runLeave(ctx: GuildCommandContext): Promise<void> {
    const row = await getNetworkGuild(ctx.guild.id);
    if (!row || row.status === NetworkStatus.NONE) throw new BiomeHuntError("This server is not in the Network.");
    const deps = defaultMembershipDeps(ctx.client);
    await ctx.open(
        confirm({
            name: "biomehunt.net-leave",
            title: "Leave the Network?",
            fields: [
                { label: "Status", value: row.status },
                { label: "To come back", value: "eligibility check and owner approval again" },
            ],
            color: 0xf43f5e,
            onConfirm: async () => {
                const left = await leaveNetwork(ctx.guild.id, deps);
                return left
                    ? EmbedFormatter.success("This server left the Network.")
                    : EmbedFormatter.info("This server was already out of the Network.");
            },
        }),
        undefined,
    );
}

async function runExclusion(ctx: GuildCommandContext, sub: "exclude" | "include"): Promise<void> {
    const user = await ctx.args.getUser("user");
    if (!user) throw new BiomeHuntError("Missing required argument: user");
    const deps = defaultMembershipDeps(ctx.client);

    if (sub === "exclude") {
        const added = await excludeMember(ctx.guild.id, user.id, ctx.user.id, deps);
        await ctx.reply(
            added
                ? EmbedFormatter.success(`<@${user.id}>'s finds will no longer be published to the Network. They still show here.`)
                : EmbedFormatter.info(`<@${user.id}> is already excluded from the Network.`),
        );
        return;
    }

    const removed = await includeMember(ctx.guild.id, user.id, deps);
    await ctx.reply(
        removed
            ? EmbedFormatter.success(`<@${user.id}>'s finds will be published to the Network again.`)
            : EmbedFormatter.info(`<@${user.id}> was not excluded.`),
    );
}
