import type { Message, User } from "discord.js";
import { ContainerBuilder, MessageFlags, PermissionFlagsBits, SeparatorSpacingSize, SlashCommandBuilder } from "discord.js";
import { type CommandContext, defineCommand, type ReplyPayload } from "@/define";
import { CommandCategory } from "@/types";
import { EmbedFormatter, formatCodeblock, formatTime, NO_PINGS, unix } from "@/utils/format";
import { ALL_BIOME_CATEGORIES, BIOME_CATEGORY_LABELS, BIOME_META, formatBiomeName, getBiomeAnsiColor } from "../constants/biomes.constants";
import {
    getBiomeCounts,
    getBiomeTopContributors,
    getGuildBiomeCounts,
    getGuildSessionOverview,
    getLongestSessions,
    getRecentSessions,
    getUserLongestSessionRank,
} from "../repository/activity.repository";
import { getUserByDiscordId } from "../repository/users.repository";
import { biomesStatsView, sessionsStatsView, usersStatsView } from "../views/bh-stats.view";
import { buildGuildStatsContainer, getUserListPage } from "../views/stats-builders";

const ANSI_RESET = "\u001b[0m";

/** The shape `send` accepts for the non-interactive (single-user) stats replies. */
type StatsPayload = Exclude<ReplyPayload, string>;

function addDivider(container: ContainerBuilder): void {
    container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
}

function baseContainer(): ContainerBuilder {
    return new ContainerBuilder().setAccentColor(0x5865f2);
}

// ─── Biomes ─────────────────────────────────────────────────────────────────

function biomeLinesByCategory(
    counts: Array<{ biome: string; count: number }>,
    lineFor: (c: { biome: string; count: number }) => string,
): string[] {
    const blocks: string[] = [];
    for (const category of ALL_BIOME_CATEGORIES) {
        const inCategory = counts.filter((c) => BIOME_META[c.biome]?.category === category);
        if (inCategory.length === 0) continue;
        const total = inCategory.reduce((sum, c) => sum + c.count, 0);
        blocks.push(`**${BIOME_CATEGORY_LABELS[category]} (${total})**\n${formatCodeblock(inCategory.map(lineFor).join("\n"), "ansi")}`);
    }
    return blocks;
}

async function buildBiomesOverviewContainer(guildId: string): Promise<ContainerBuilder> {
    const counts = await getGuildBiomeCounts(guildId);
    const container = baseContainer();
    container.addTextDisplayComponents((td) => td.setContent("## 🌍 Guild Biome Stats"));
    addDivider(container);

    if (counts.length === 0) {
        container.addTextDisplayComponents((td) => td.setContent("*No biomes found yet.*"));
        return container;
    }

    const line = (c: { biome: string; count: number }) =>
        `${getBiomeAnsiColor(c.biome)}${formatBiomeName(c.biome)}${ANSI_RESET}: ${c.count}`;
    for (const block of biomeLinesByCategory(counts, line)) {
        container.addTextDisplayComponents((td) => td.setContent(block));
        addDivider(container);
    }
    return container;
}

async function buildBiomesContributorsContainer(guildId: string): Promise<ContainerBuilder> {
    const top = await getBiomeTopContributors(guildId);
    const container = baseContainer();
    container.addTextDisplayComponents((td) => td.setContent("## 🏅 Top Contributor per Biome"));
    addDivider(container);

    if (top.length === 0) {
        container.addTextDisplayComponents((td) => td.setContent("*No biomes found yet.*"));
        return container;
    }

    for (const category of ALL_BIOME_CATEGORIES) {
        const inCategory = top.filter((t) => BIOME_META[t.biome]?.category === category);
        if (inCategory.length === 0) continue;
        const lines = inCategory.map((t) => `${formatBiomeName(t.biome)}: <@${t.discordUserId}> (\`${t.count}\`)`);
        container.addTextDisplayComponents((td) => td.setContent(`**${BIOME_CATEGORY_LABELS[category]}**\n${lines.join("\n")}`));
        addDivider(container);
    }
    return container;
}

async function buildUserBiomesContainer(discordUserId: string, userRowId: number): Promise<ContainerBuilder> {
    const counts = await getBiomeCounts(userRowId);
    const container = baseContainer();
    container.addTextDisplayComponents((td) => td.setContent(`## 🌍 <@${discordUserId}>'s Biomes`));
    addDivider(container);

    if (counts.length === 0) {
        container.addTextDisplayComponents((td) => td.setContent("*No biomes found yet.*"));
        return container;
    }

    const line = (c: { biome: string; count: number }) =>
        `${getBiomeAnsiColor(c.biome)}${formatBiomeName(c.biome)}${ANSI_RESET}: ${c.count}`;
    for (const block of biomeLinesByCategory(counts, line)) {
        container.addTextDisplayComponents((td) => td.setContent(block));
        addDivider(container);
    }
    return container;
}

async function runBiomesStats(ctx: CommandContext, guildId: string): Promise<void> {
    const [overview, contributors] = await Promise.all([buildBiomesOverviewContainer(guildId), buildBiomesContributorsContainer(guildId)]);
    await ctx.open(biomesStatsView, { overview, contributors });
}

async function runUserBiomesStats(guildId: string, target: User, send: (payload: StatsPayload) => Promise<Message>): Promise<void> {
    const user = await getUserByDiscordId(guildId, target.id);
    if (!user) {
        await send(EmbedFormatter.info(`<@${target.id}> has no BiomeHunt profile in this server.`));
        return;
    }
    const container = await buildUserBiomesContainer(target.id, user.id);
    await send({ flags: MessageFlags.IsComponentsV2, components: [container] });
}

// ─── Sessions ───────────────────────────────────────────────────────────────

async function buildSessionsOverviewContainer(guildId: string): Promise<ContainerBuilder> {
    const stats = await getGuildSessionOverview(guildId);
    const container = baseContainer();
    container.addTextDisplayComponents((td) => td.setContent("## ⏱️ Guild Session Stats"));
    addDivider(container);
    container.addTextDisplayComponents((td) =>
        td.setContent(
            [
                `- Total sessions: \`${stats.totalSessions}\``,
                `- Total time logged: \`${formatTime(stats.totalSeconds)}\``,
                `- Average session length: \`${formatTime(Math.round(stats.avgSeconds))}\``,
                `- Members with at least one session: \`${stats.distinctUsers}\``,
            ].join("\n"),
        ),
    );
    return container;
}

async function buildLongestSessionsContainer(guildId: string): Promise<ContainerBuilder> {
    const rows = await getLongestSessions(guildId, 10);
    const container = baseContainer();
    container.addTextDisplayComponents((td) => td.setContent("## 🏆 Longest Sessions"));
    addDivider(container);

    if (rows.length === 0) {
        container.addTextDisplayComponents((td) => td.setContent("*No sessions recorded yet.*"));
        return container;
    }

    const lines = rows.map(
        (r, i) => `**${i + 1}.** <@${r.discordUserId}> — \`${formatTime(r.duration_seconds)}\` · <t:${unix(r.started_at)}:D>`,
    );
    container.addTextDisplayComponents((td) => td.setContent(lines.join("\n")));
    return container;
}

async function buildUserSessionsContainer(guildId: string, discordUserId: string, userRowId: number): Promise<ContainerBuilder> {
    const [recent, rank] = await Promise.all([getRecentSessions(userRowId, 5), getUserLongestSessionRank(guildId, userRowId)]);
    const container = baseContainer();
    container.addTextDisplayComponents((td) => td.setContent(`## ⏱️ <@${discordUserId}>'s Sessions`));
    addDivider(container);

    if (recent.length === 0) {
        container.addTextDisplayComponents((td) => td.setContent("*No sessions recorded yet.*"));
        return container;
    }

    const lines = recent.map((s) => `\`#${s.id}\` \`${formatTime(s.duration_seconds)}\` · ended <t:${unix(s.ended_at)}:R>`);
    container.addTextDisplayComponents((td) => td.setContent(`**Recent sessions**\n${lines.join("\n")}`));

    if (rank) {
        addDivider(container);
        container.addTextDisplayComponents((td) =>
            td.setContent(
                `🏆 Longest session: \`${formatTime(rank.longestSeconds)}\` — **#${rank.rank}** of ${rank.totalSessions} in the guild`,
            ),
        );
    }
    return container;
}

async function runSessionsStats(ctx: CommandContext, guildId: string): Promise<void> {
    const [overview, longest] = await Promise.all([buildSessionsOverviewContainer(guildId), buildLongestSessionsContainer(guildId)]);
    await ctx.open(sessionsStatsView, { overview, longest });
}

async function runUserSessionsStats(guildId: string, target: User, send: (payload: StatsPayload) => Promise<Message>): Promise<void> {
    const user = await getUserByDiscordId(guildId, target.id);
    if (!user) {
        await send(EmbedFormatter.info(`<@${target.id}> has no BiomeHunt profile in this server.`));
        return;
    }
    const container = await buildUserSessionsContainer(guildId, target.id, user.id);
    await send({ flags: MessageFlags.IsComponentsV2, components: [container] });
}

// ─── Users ──────────────────────────────────────────────────────────────────

async function runUsersStats(ctx: CommandContext, guildId: string): Promise<void> {
    const [overview, active, idle, inactive] = await Promise.all([
        buildGuildStatsContainer(guildId),
        getUserListPage(guildId, "active"),
        getUserListPage(guildId, "idle"),
        getUserListPage(guildId, "inactive"),
    ]);
    await ctx.open(usersStatsView, { overview, usersByStatus: { active, idle, inactive } });
}

// ─── Command ────────────────────────────────────────────────────────────────

export default defineCommand({
    name: "bh-stats",
    description: "Guild-wide (or per-user) BiomeHunt stats - biomes, sessions, and member activity.",
    category: CommandCategory.ADMIN,
    showOnHelp: true,
    guildOnly: true,
    adminOnly: true,

    options: new SlashCommandBuilder()
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand((s) =>
            s
                .setName("biomes")
                .setDescription("Guild-wide biome stats, or one user's if given.")
                .addUserOption((o) => o.setName("user").setDescription("Scope to one user instead of the whole guild")),
        )
        .addSubcommand((s) =>
            s
                .setName("sessions")
                .setDescription("Guild-wide session stats, or one user's if given.")
                .addUserOption((o) => o.setName("user").setDescription("Scope to one user instead of the whole guild")),
        )
        .addSubcommand((s) => s.setName("users").setDescription("Browse guild members by activity status.")),

    async run(ctx) {
        const sub = ctx.args.getSubcommand();
        const guildId = ctx.guild.id;
        const send = (payload: StatsPayload) => ctx.reply({ ...payload, allowedMentions: NO_PINGS });

        await ctx.defer();
        if (sub === "biomes") {
            const target = await ctx.args.getUser("user");
            await (target ? runUserBiomesStats(guildId, target, send) : runBiomesStats(ctx, guildId));
            return;
        }
        if (sub === "sessions") {
            const target = await ctx.args.getUser("user");
            await (target ? runUserSessionsStats(guildId, target, send) : runSessionsStats(ctx, guildId));
            return;
        }
        await runUsersStats(ctx, guildId);
    },
});
