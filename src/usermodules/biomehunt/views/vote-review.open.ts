import type { ApplicationCommandOptionChoiceData, Guild } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import type { CommandContext } from "@/define";
import { formatBiomeName } from "../constants/biomes.constants";
import { getNetworkPostIdByMirrorMessage, getRecentNetworkPostsInGuild } from "../repository/network-posts.repository";
import { getRecentGuildVotes, getVoteByMessage } from "../repository/votes.repository";
import { BiomeHuntError } from "../types";
import { defaultMemberAdminDeps, memberAdminView } from "./member-admin.view";
import { defaultVoteReviewDeps, type VoteReviewDeps, voteReviewView } from "./vote-review.view";

const RECENT = 25;

/** The review's deps for `admin` in `guild`: "Finder's quality" opens the finder's member panel on Quality. */
export function reviewDepsFor(client: BotClient, guild: Guild, adminId: string): VoteReviewDeps {
    return defaultVoteReviewDeps(client, async (discordUserId) => {
        const member = await guild.members.fetch(discordUserId).catch(() => null);
        if (!member) return null;
        return memberAdminView(member, defaultMemberAdminDeps(client, guild, member, adminId), { tab: "quality" }) as never;
    });
}

/** Opens the review of a local vote id or Network post id. Shared by `/admin review-vote` and the "Review vote" message menu. */
export async function openVoteReview(ctx: CommandContext, guild: Guild, id: string): Promise<void> {
    await ctx.defer();
    await ctx.open(voteReviewView(reviewDepsFor(ctx.client, guild, ctx.user.id)), { id, guildId: guild.id, viewerId: ctx.user.id });
}

/** The vote a forward or Mirror message in `guildId` carries - `null` when it's neither. */
export async function voteIdOfMessage(guildId: string, messageId: string): Promise<string | null> {
    const vote = await getVoteByMessage(guildId, messageId);
    return vote?.id ?? (await getNetworkPostIdByMirrorMessage(guildId, messageId));
}

/** `5m ago` / `3h ago` / `2d ago` - autocomplete labels can't render timestamps. */
function ago(at: Date, now: Date): string {
    const minutes = Math.max(0, Math.round((now.getTime() - at.getTime()) / 60_000));
    if (minutes < 60) return `${minutes}m ago`;
    if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h ago`;
    return `${Math.round(minutes / 1440)}d ago`;
}

/**
 * `/admin review-vote find:` choices: the server's newest rare-find votes and the newest Network
 * finds mirrored here from other servers (its own Network finds open from their local vote), as
 * `Glitched · masutty · 5m ago · Local`. Filtered by what was typed, id included.
 */
export async function reviewVoteChoices(
    guild: Guild,
    typed: string,
    now = new Date(),
): Promise<ApplicationCommandOptionChoiceData<string>[]> {
    const [votes, posts] = await Promise.all([getRecentGuildVotes(guild.id, RECENT), getRecentNetworkPostsInGuild(guild.id, RECENT)]);
    const name = (id: string | null) =>
        id ? (guild.members.cache.get(id)?.displayName ?? guild.client.users.cache.get(id)?.username ?? id) : "unknown";
    const rows = [
        ...votes.map((v) => ({
            id: v.id,
            at: v.created_at,
            label: `${formatBiomeName(v.biome)} · ${name(v.finder_discord_id)} · ${ago(v.created_at, now)} · Local`,
        })),
        ...posts
            .filter((p) => p.origin_guild_id !== guild.id)
            .map((p) => ({
                id: p.id,
                at: p.created_at,
                label: `${formatBiomeName(p.biome)} · ${name(p.finder_discord_id)} · ${ago(p.created_at, now)} · Network`,
            })),
    ].sort((a, b) => b.at.getTime() - a.at.getTime());
    const q = typed.trim().toLowerCase();
    return rows
        .filter((r) => !q || r.label.toLowerCase().includes(q) || r.id.includes(q))
        .slice(0, RECENT)
        .map((r) => ({ name: r.label.slice(0, 100), value: r.id }));
}

/** The id the "Review vote" message menu was used on, or a clear error. */
export async function requireVoteIdOfMessage(guildId: string, messageId: string | null): Promise<string> {
    const id = messageId ? await voteIdOfMessage(guildId, messageId) : null;
    if (!id) throw new BiomeHuntError("That message isn't a rare find with a vote.");
    return id;
}
