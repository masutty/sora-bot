import type { Client, MessageCreateOptions, MessageEditOptions } from "discord.js";
import { MessageFlags } from "discord.js";
import { NO_PINGS } from "@/utils/format";
import { Logger } from "@/utils/logging";
import { formatBiomeName, getBiomeMeta } from "../constants/biomes.constants";
import { getNetworkGuild, isNetworkBanned } from "../repository/network.repository";
import {
    closeNetworkVoteRow,
    deleteNetworkAlertsForPost,
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
    deleteNetworkAlertsForPost: typeof deleteNetworkAlertsForPost;
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
        deleteNetworkAlertsForPost,
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

export type DecideNetworkVoteResult = "ok" | "already_decided" | "not_found";

/**
 * The bot owner's decision (a click on a Mirror, or Mark real / Mark fake on the vote's review):
 * open or closed, the vote's result becomes `choice` - an override of the Network's verdict or of an
 * earlier decision. A compare-and-set on the status it read keeps two racing decisions (or the
 * Worker) from both applying. Overturning a Fake verdict drops its alert and tells the origin's staff.
 */
export async function decideNetworkVote(
    postId: string,
    ownerId: string,
    choice: VoteChoice,
    deps: NetworkVoteDeps,
): Promise<DecideNetworkVoteResult> {
    const post = await deps.getNetworkPost(postId);
    if (!post) return "not_found";
    const status = choice === VoteChoice.REAL ? "real" : "fake";
    if (post.vote_status === status) return "ok";
    const closed = await deps.closeNetworkVoteRow(postId, status, ownerId, ownerId, post.vote_status);
    if (!closed) return "already_decided";
    await publishResult(closed, status, deps);
    if (post.vote_status === "fake") await clearFakeVerdict(closed, deps);
    return "ok";
}

/**
 * Closes one open Network vote (the Worker when its minute is up, or `/network-admin close-vote`):
 * resolves it from the ballots, closes it with a compare-and-set (so the Worker and an owner never
 * both apply it), then publishes the result (see `publishResult`).
 */
export async function closeNetworkVote(
    postId: string,
    closedBy: string | null,
    deps: NetworkVoteDeps,
): Promise<"ok" | "already_closed" | "not_found"> {
    const post = await deps.getNetworkPost(postId);
    if (!post) return "not_found";
    const { status } = resolveNetworkVote(await deps.getNetworkBallots(postId));
    const closed = await deps.closeNetworkVoteRow(postId, status, closedBy);
    if (!closed) return "already_closed";
    await publishResult(closed, status, deps);
    return "ok";
}

/** Edits every Mirror once with the vote's new result, and on a Fake verdict warns the origin's staff (and the owners, unless one decided it). */
async function publishResult(closed: NetworkPostRow, status: NetworkVoteResult, deps: NetworkVoteDeps): Promise<void> {
    // Read after the close committed - a ballot racing it is either counted here or was rejected.
    const final = resolveNetworkVote(await deps.getNetworkBallots(closed.id));
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
    for (const mirror of await deps.getNetworkMirrors(closed.id)) await deps.editMirror(mirror, payloadFor(mirror));

    if (status === "fake") await reportFakeVerdict(closed, final.scoreboard, deps);
}

async function clearFakeVerdict(post: NetworkPostRow, deps: NetworkVoteDeps): Promise<void> {
    await deps.deleteNetworkAlertsForPost("fake_verdict", post.id);
    const origin = await deps.getNetworkGuild(post.origin_guild_id);
    if (origin) {
        await deps.notifyStaff(
            origin,
            `✅ **The bot owner marked the ${formatBiomeName(post.biome)} find by <@${post.finder_discord_id}> real.** Its Fake verdict no longer counts.`,
        );
    }
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
