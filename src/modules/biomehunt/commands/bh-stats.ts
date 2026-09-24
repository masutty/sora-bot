import { ButtonStyle, ContainerBuilder, MessageFlags, PermissionFlagsBits, SeparatorSpacingSize, SlashCommandBuilder } from "discord.js";
import type { Message, User } from "discord.js";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import { runButtonView, type ButtonViewButton, type ButtonViewFinalPayload, type ButtonViewRender } from "@/utils/buttonView";
import { EmbedFormatter, formatTime, NO_PINGS, unix, formatCodeblock } from "@/utils/format";
import {
    getBiomeCounts, getBiomeTopContributors, getGuildBiomeCounts, getGuildSessionOverview,
    getLongestSessions, getRecentSessions, getUserLongestSessionRank,
} from "../repository/activity";
import { getUserByDiscordId } from "../repository/users";
import { buildGuildStatsContainer, buildUserListContainer, getUserListPage, USERS_PER_PAGE } from "./profileViews";
import {
    ALL_BIOME_CATEGORIES, BiomeHuntError, BIOME_CATEGORY_LABELS, BIOME_META, formatBiomeName, getBiomeAnsiColor,
    type ActivityStatus,
} from "../types";

const ANSI_RESET = "\u001b[0m";

function addDivider(container: ContainerBuilder): void {
    container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
}

function baseContainer(): ContainerBuilder {
    return new ContainerBuilder().setAccentColor(0x5865f2);
}

// ─── Biomes ─────────────────────────────────────────────────────────────────

function biomeLinesByCategory(counts: Array<{ biome: string; count: number }>, lineFor: (c: { biome: string; count: number }) => string): string[] {
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

    const line = (c: { biome: string; count: number }) => `${getBiomeAnsiColor(c.biome)}${formatBiomeName(c.biome)}${ANSI_RESET}: ${c.count}`;
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

    const line = (c: { biome: string; count: number }) => `${getBiomeAnsiColor(c.biome)}${formatBiomeName(c.biome)}${ANSI_RESET}: ${c.count}`;
    for (const block of biomeLinesByCategory(counts, line)) {
        container.addTextDisplayComponents((td) => td.setContent(block));
        addDivider(container);
    }
    return container;
}

type BiomesTab = "overview" | "contributors";

async function runBiomesStats(guildId: string, invokerId: string, send: (payload: ButtonViewFinalPayload) => Promise<Message>): Promise<void> {
    const [overview, contributors] = await Promise.all([buildBiomesOverviewContainer(guildId), buildBiomesContributorsContainer(guildId)]);
    const containers: Record<BiomesTab, ContainerBuilder> = { overview, contributors };

    await runButtonView<BiomesTab>({
        state: "overview",
        invokerId,
        respond: send,
        render: (tab): ButtonViewRender<BiomesTab> => ({
            payload: { flags: MessageFlags.IsComponentsV2, components: [containers[tab]] },
            buttons: [[
                { customId: "bhstats-biomes-overview", label: "Overview", style: tab === "overview" ? ButtonStyle.Primary : ButtonStyle.Secondary, next: () => "overview" },
                { customId: "bhstats-biomes-contributors", label: "Top Contributors", style: tab === "contributors" ? ButtonStyle.Primary : ButtonStyle.Secondary, next: () => "contributors" },
            ]],
        }),
    });
}

async function runUserBiomesStats(guildId: string, target: User, send: (payload: ButtonViewFinalPayload) => Promise<Message>): Promise<void> {
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

    const lines = rows.map((r, i) => `**${i + 1}.** <@${r.discordUserId}> — \`${formatTime(r.duration_seconds)}\` · <t:${unix(r.started_at)}:D>`);
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
            td.setContent(`🏆 Longest session: \`${formatTime(rank.longestSeconds)}\` — **#${rank.rank}** of ${rank.totalSessions} in the guild`),
        );
    }
    return container;
}

type SessionsTab = "overview" | "longest";

async function runSessionsStats(guildId: string, invokerId: string, send: (payload: ButtonViewFinalPayload) => Promise<Message>): Promise<void> {
    const [overview, longest] = await Promise.all([buildSessionsOverviewContainer(guildId), buildLongestSessionsContainer(guildId)]);
    const containers: Record<SessionsTab, ContainerBuilder> = { overview, longest };

    await runButtonView<SessionsTab>({
        state: "overview",
        invokerId,
        respond: send,
        render: (tab): ButtonViewRender<SessionsTab> => ({
            payload: { flags: MessageFlags.IsComponentsV2, components: [containers[tab]] },
            buttons: [[
                { customId: "bhstats-sessions-overview", label: "Overview", style: tab === "overview" ? ButtonStyle.Primary : ButtonStyle.Secondary, next: () => "overview" },
                { customId: "bhstats-sessions-longest", label: "🏆 Longest Sessions", style: tab === "longest" ? ButtonStyle.Primary : ButtonStyle.Secondary, next: () => "longest" },
            ]],
        }),
    });
}

async function runUserSessionsStats(guildId: string, target: User, send: (payload: ButtonViewFinalPayload) => Promise<Message>): Promise<void> {
    const user = await getUserByDiscordId(guildId, target.id);
    if (!user) {
        await send(EmbedFormatter.info(`<@${target.id}> has no BiomeHunt profile in this server.`));
        return;
    }
    const container = await buildUserSessionsContainer(guildId, target.id, user.id);
    await send({ flags: MessageFlags.IsComponentsV2, components: [container] });
}

// ─── Users ──────────────────────────────────────────────────────────────────

interface UsersState {
    status: "overview" | ActivityStatus;
    page: number;
}

const STATUS_BUTTON_LABELS: Record<ActivityStatus, string> = { active: "🟢 Active", idle: "🟡 Idle", inactive: "🔴 Inactive" };

async function runUsersStats(guildId: string, invokerId: string, send: (payload: ButtonViewFinalPayload) => Promise<Message>): Promise<void> {
    const [overview, active, idle, inactive] = await Promise.all([
        buildGuildStatsContainer(guildId),
        getUserListPage(guildId, "active"),
        getUserListPage(guildId, "idle"),
        getUserListPage(guildId, "inactive"),
    ]);
    const usersByStatus: Record<ActivityStatus, Awaited<ReturnType<typeof getUserListPage>>> = { active, idle, inactive };

    const statusRow = (state: UsersState): ButtonViewButton<UsersState>[] => [
        { customId: "bhstats-users-overview", label: "Overview", style: state.status === "overview" ? ButtonStyle.Primary : ButtonStyle.Secondary, next: (): UsersState => ({ status: "overview", page: 0 }) },
        ...(["active", "idle", "inactive"] as ActivityStatus[]).map((status) => ({
            customId: `bhstats-users-${status}`,
            label: STATUS_BUTTON_LABELS[status],
            style: state.status === status ? ButtonStyle.Primary : ButtonStyle.Secondary,
            next: (): UsersState => ({ status, page: 0 }),
        })),
    ];

    await runButtonView<UsersState>({
        state: { status: "overview", page: 0 },
        invokerId,
        respond: send,
        render: (state): ButtonViewRender<UsersState> => {
            if (state.status === "overview") {
                return { payload: { flags: MessageFlags.IsComponentsV2, components: [overview] }, buttons: [statusRow(state)] };
            }

            const users = usersByStatus[state.status];
            const pages = Math.max(Math.ceil(users.length / USERS_PER_PAGE), 1);
            const container = buildUserListContainer(users, state.page, state.status);

            const paginationRow: ButtonViewButton<UsersState>[] = pages > 1 ? [
                {
                    customId: "bhstats-users-page-prev", emoji: "⬅️",
                    next: (s): UsersState => ({ ...s, page: s.page > 0 ? s.page - 1 : pages - 1 }),
                },
                {
                    customId: "bhstats-users-page-next", emoji: "➡️",
                    next: (s): UsersState => ({ ...s, page: s.page < pages - 1 ? s.page + 1 : 0 }),
                },
            ] : [];

            return {
                payload: { flags: MessageFlags.IsComponentsV2, components: [container] },
                buttons: [statusRow(state), ...(paginationRow.length > 0 ? [paginationRow] : [])],
            };
        },
    });
}

// ─── Command ────────────────────────────────────────────────────────────────

export default defineCommand({
    name: "bh-stats",
    description: "Guild-wide (or per-user) BiomeHunt stats - biomes, sessions, and member activity.",
    category: CommandCategory.ADMIN,
    showOnHelp: true,
    adminOnly: true,

    options: new SlashCommandBuilder()
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand((s) =>
            s.setName("biomes").setDescription("Guild-wide biome stats, or one user's if given.")
                .addUserOption((o) => o.setName("user").setDescription("Scope to one user instead of the whole guild")),
        )
        .addSubcommand((s) =>
            s.setName("sessions").setDescription("Guild-wide session stats, or one user's if given.")
                .addUserOption((o) => o.setName("user").setDescription("Scope to one user instead of the whole guild")),
        )
        .addSubcommand((s) => s.setName("users").setDescription("Browse guild members by activity status.")),

    async executeAsSlash(interaction) {
        if (!interaction.guild) {
            await interaction.reply({ content: "This command only works in a server.", ephemeral: true });
            return;
        }
        const sub = interaction.options.getSubcommand(true);
        const guildId = interaction.guild.id;
        const invokerId = interaction.user.id;
        const send = (payload: ButtonViewFinalPayload) => interaction.editReply({ ...payload, allowedMentions: NO_PINGS });

        await interaction.deferReply();
        try {
            if (sub === "biomes") {
                const target = interaction.options.getUser("user");
                await (target ? runUserBiomesStats(guildId, target, send) : runBiomesStats(guildId, invokerId, send));
                return;
            }
            if (sub === "sessions") {
                const target = interaction.options.getUser("user");
                await (target ? runUserSessionsStats(guildId, target, send) : runSessionsStats(guildId, invokerId, send));
                return;
            }
            await runUsersStats(guildId, invokerId, send);
        } catch (err) {
            const text = err instanceof BiomeHuntError ? err.message : "Something went wrong.";
            await interaction.editReply({ ...EmbedFormatter.error(text), allowedMentions: NO_PINGS });
        }
    },

    async executeAsPrefix(message, args) {
        if (!message.guild) {
            await message.reply("This command only works in a server.");
            return;
        }
        const sub = args.getSubcommand();
        if (!sub) {
            await message.reply(EmbedFormatter.info("Run `bh-stats biomes [user]`, `bh-stats sessions [user]`, or `bh-stats users`."));
            return;
        }

        const guildId = message.guild.id;
        const invokerId = message.author.id;
        const send = (payload: ButtonViewFinalPayload) => message.reply({ ...payload, allowedMentions: NO_PINGS });

        try {
            if (sub === "biomes") {
                const target = await args.getUser("user");
                await (target ? runUserBiomesStats(guildId, target, send) : runBiomesStats(guildId, invokerId, send));
                return;
            }
            if (sub === "sessions") {
                const target = await args.getUser("user");
                await (target ? runUserSessionsStats(guildId, target, send) : runSessionsStats(guildId, invokerId, send));
                return;
            }
            if (sub === "users") {
                await runUsersStats(guildId, invokerId, send);
                return;
            }
        } catch (err) {
            const text = err instanceof BiomeHuntError ? err.message : "Something went wrong.";
            await message.reply({ ...EmbedFormatter.error(text), allowedMentions: NO_PINGS });
        }
    },
});
