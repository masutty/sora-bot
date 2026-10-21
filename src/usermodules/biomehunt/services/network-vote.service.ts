import type { Client, MessageCreateOptions, MessageEditOptions } from "discord.js";
import { MessageFlags } from "discord.js";
import { NO_PINGS } from "@/utils/format";
import { Logger } from "@/utils/logging";
import { formatBiomeName, getBiomeMeta } from "../constants/biomes.constants";
import { getNetworkGuild, isNetworkBanned } from "../repository/network.repository";
import {
    closeNetworkVoteRow,
    getDueOpenNetworkVotes,
    getNetworkBallots,
    getNetworkMirrors,
    getNetworkPost,
    insertNetworkAlert,
    insertNetworkBallot,
} from "../repository/network-posts.repository";
import {
    type NetworkBallotRow,
    type NetworkGuildRow,
    type NetworkMirrorRow,
    type NetworkPostRow,
    NetworkStatus,
    VoteChoice,
} from "../types";
import { buildMirrorContainer, formatScoreboard, type Scoreboard, serverNameLink } from "../views/network-mirror.view";
import { notifyStaff } from "./network-membership.service";
import { notifyOwners } from "./owner-dm.service";

const logger = new Logger("biomehunt.services.network-vote");

export type NetworkVoteResult = "real" | "fake" | "inconclusive";

/**
 * The pure heart of the Network vote: one ballot per person, from any Member Server. More Real than
 * Fake is real, the reverse is fake, a tie (or no ballots) is inconclusive - the local vote's rule.
 */
export function resolveNetworkVote(ballots: ReadonlyArray<Pick<NetworkBallotRow, "choice">>): {
    status: NetworkVoteResult;
    scoreboard: Scoreboard;
} {
    const real = ballots.filter((b) => b.choice === VoteChoice.REAL).length;
    const fake = ballots.length - real;
    const status: NetworkVoteResult = real === fake ? "inconclusive" : real > fake ? "real" : "fake";
    return { status, scoreboard: { real, fake } };
}

/** Everything the vote would otherwise call on the DB or Discord, injected so its tests touch neither. */
export interface NetworkVoteDeps {
    getNetworkPost: typeof getNetworkPost;
    getNetworkGuild: typeof getNetworkGuild;
    isNetworkBanned: typeof isNetworkBanned;
    insertNetworkBallot: typeof insertNetworkBallot;
    getNetworkBallots: typeof getNetworkBallots;
    getDueOpenNetworkVotes: typeof getDueOpenNetworkVotes;
    closeNetworkVoteRow: typeof closeNetworkVoteRow;
    getNetworkMirrors: typeof getNetworkMirrors;
    /** Edits one Mirror. Must never throw - a deleted message or channel just isn't edited. */
    editMirror: (mirror: NetworkMirrorRow, payload: MessageEditOptions) => Promise<void>;
    notifyStaff: (row: NetworkGuildRow, content: string) => Promise<void>;
    notifyOwners: (payload: MessageCreateOptions) => Promise<void>;
    insertNetworkAlert: typeof insertNetworkAlert;
    now: () => Date;
}

export function defaultNetworkVoteDeps(client: Client): NetworkVoteDeps {
    return {
        getNetworkPost,
        getNetworkGuild,
        isNetworkBanned,
        insertNetworkBallot,
        getNetworkBallots,
        getDueOpenNetworkVotes,
        closeNetworkVoteRow,
        getNetworkMirrors,
        editMirror: (mirror, payload) => editMirror(client, mirror, payload),
        notifyStaff: (row, content) => notifyStaff(client, row, content),
        notifyOwners: (payload) => notifyOwners(client, payload),
        insertNetworkAlert,
        now: () => new Date(),
    };
}

async function editMirror(client: Client, mirror: NetworkMirrorRow, payload: MessageEditOptions): Promise<void> {
    try {
        const channel = await client.channels.fetch(mirror.channel_id);
        if (!channel || channel.isDMBased() || !channel.isTextBased()) return;
        const message = await channel.messages.fetch(mirror.message_id);
        await message.edit(payload);
    } catch (err) {
        logger.warn(`Could not edit Network Mirror ${mirror.post_id} in guild ${mirror.guild_id}`, {
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

export type CastNetworkBallotResult =
    | { kind: "ok"; scoreboard: Scoreboard }
    | { kind: "changed"; scoreboard: Scoreboard }
    | { kind: "unchanged"; scoreboard: Scoreboard }
    | { kind: "change_locked"; scoreboard: Scoreboard }
    | { kind: "not_found" }
    | { kind: "closed" }
    | { kind: "finder" }
    | { kind: "banned" }
    | { kind: "not_member" };

async function currentScoreboard(postId: string, deps: NetworkVoteDeps): Promise<Scoreboard> {
    return resolveNetworkVote(await deps.getNetworkBallots(postId)).scoreboard;
}

/**
 * One Network ballot, clicked on a Mirror in `guildId` (kept to show where it came from - every
 * person counts the same). One per person per post across every server; the other choice can be
 * picked once more, then it's locked. The finder can't vote unless `canVoteOnOwnFind` (an admin or
 * owner of the server they clicked in); Network-banned users never can.
 */
export async function castNetworkBallot(
    postId: string,
    discordUserId: string,
    guildId: string,
    choice: VoteChoice,
    canVoteOnOwnFind: boolean,
    deps: NetworkVoteDeps,
): Promise<CastNetworkBallotResult> {
    const post = await deps.getNetworkPost(postId);
    if (!post || (post.status !== "published" && post.status !== "publishing")) return { kind: "not_found" };
    if (post.vote_status !== "open" || (post.vote_closes_at && deps.now() >= post.vote_closes_at)) return { kind: "closed" };
    if (post.finder_discord_id === discordUserId && !canVoteOnOwnFind) return { kind: "finder" };
    if (await deps.isNetworkBanned("user", discordUserId)) return { kind: "banned" };
    const guild = await deps.getNetworkGuild(guildId);
    if (!guild || guild.status !== NetworkStatus.MEMBER) return { kind: "not_member" };

    const written = await deps.insertNetworkBallot(postId, discordUserId, guildId, choice);
    if (written === "closed") return { kind: "closed" };
    const scoreboard = await currentScoreboard(postId, deps);
    return { kind: written === "inserted" ? "ok" : written, scoreboard };
}

/** The bot owner's click on a Mirror: decides the vote on the spot and closes it (see `closeNetworkVote`). */
export function decideNetworkVote(
    postId: string,
    ownerId: string,
    choice: VoteChoice,
    deps: NetworkVoteDeps,
): Promise<"ok" | "already_closed" | "not_found"> {
    return closeNetworkVote(postId, ownerId, deps, choice);
}

/**
 * Closes one Network vote (the Worker when its minute is up, `/network-admin close-vote`, or the bot
 * owner's click with a `decision`): resolves it from the ballots unless decided, closes it with a
 * compare-and-set (so the Worker and an owner never both apply it), edits every Mirror once with the
 * result, and on a Fake verdict warns the origin's staff (and the owners, unless one decided it).
 */
export async function closeNetworkVote(
    postId: string,
    closedBy: string | null,
    deps: NetworkVoteDeps,
    decision?: VoteChoice,
): Promise<"ok" | "already_closed" | "not_found"> {
    const post = await deps.getNetworkPost(postId);
    if (!post) return "not_found";
    const status = decision
        ? decision === VoteChoice.REAL
            ? "real"
            : "fake"
        : resolveNetworkVote(await deps.getNetworkBallots(postId)).status;
    const closed = await deps.closeNetworkVoteRow(postId, status, closedBy, decision ? closedBy : null);
    if (!closed) return "already_closed";

    // Read after the close committed - a ballot racing it is either counted here or was rejected.
    const final = resolveNetworkVote(await deps.getNetworkBallots(postId));
    // Each Mirror is rebuilt with the ping role it was sent with, so the mention stays visible - an
    // edit never pings again.
    const payloadFor = (mirror: NetworkMirrorRow): MessageEditOptions => ({
        components: [
            buildMirrorContainer({
                post: closed,
                roleId: mirror.role_id,
                home: mirror.guild_id === closed.origin_guild_id,
                vote: { status, scoreboard: final.scoreboard, decidedBy: closed.vote_decided_by },
                flavorText: getBiomeMeta(closed.biome)?.flavorText,
            }),
        ],
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: NO_PINGS,
    });
    for (const mirror of await deps.getNetworkMirrors(postId)) await deps.editMirror(mirror, payloadFor(mirror));

    if (status === "fake") await reportFakeVerdict(closed, final.scoreboard, deps);
    return "ok";
}

async function reportFakeVerdict(post: NetworkPostRow, scoreboard: Scoreboard, deps: NetworkVoteDeps): Promise<void> {
    const biome = formatBiomeName(post.biome);
    const board = formatScoreboard(scoreboard);
    const decidedBy = post.vote_decided_by;
    const verdict = decidedBy
        ? `The bot owner marked a ${biome} find by <@${post.finder_discord_id}> fake`
        : `The Network voted a ${biome} find by <@${post.finder_discord_id}> fake`;
    const origin = await deps.getNetworkGuild(post.origin_guild_id);
    if (origin) {
        await deps.notifyStaff(
            origin,
            `⚠️ **${verdict}.**\n${board}\nPlease check it with them - repeated fakes can cost this server its Network access.`,
        );
    }
    const details = `${biome} by <@${post.finder_discord_id}> (\`${post.finder_discord_id}\`) from ${serverNameLink(post.origin_name, post.invite_url)} (\`${post.origin_guild_id}\`) - post \`${post.id}\`\n${board}`;
    await deps.insertNetworkAlert({
        kind: "fake_verdict",
        guildId: post.origin_guild_id,
        discordUserId: post.finder_discord_id,
        postId: post.id,
        details,
        notified: true,
    });
    // The owner who decided it already knows.
    if (!decidedBy) await deps.notifyOwners({ content: `❌ **Fake verdict**\n${details}`, allowedMentions: NO_PINGS });
}

/** The `network-vote-close` Worker's tick - each vote on its own, so one failure never skips the rest. */
export async function closeDueNetworkVotes(deps: NetworkVoteDeps): Promise<void> {
    for (const post of await deps.getDueOpenNetworkVotes(deps.now())) {
        try {
            await closeNetworkVote(post.id, null, deps);
        } catch (err) {
            logger.error(err instanceof Error ? err : new Error(String(err)), { postId: post.id });
        }
    }
}
