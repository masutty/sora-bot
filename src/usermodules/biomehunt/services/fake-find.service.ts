import { MessageFlags } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { NO_PINGS } from "@/utils/format";
import { Logger } from "@/utils/logging";
import { isFlagEnabled } from "../repository/flags.repository";
import { getMacroChannelByUserId, getUserById } from "../repository/users.repository";
import { getBallotsForVote, markFakeReported } from "../repository/votes.repository";
import type { Badge, BiomeVoteRow } from "../types";
import { VoteChoice, VoteStatus } from "../types";
import { buildFakeFindBody, buildFakeFindContainer, type FakeFindInput, fakeFindFooter } from "../views/fake-find.view";
import { guildLog } from "./guild-log.service";

const logger = new Logger("biomehunt.services.fake-find");

export interface FakeFindDeps {
    markFakeReported: typeof markFakeReported;
    isFlagEnabled: typeof isFlagEnabled;
    getMacroChannelByUserId: typeof getMacroChannelByUserId;
    getUserById: typeof getUserById;
    getBallotsForVote: typeof getBallotsForVote;
    log: typeof guildLog;
}

export function defaultFakeFindDeps(): FakeFindDeps {
    return { markFakeReported, isFlagEnabled, getMacroChannelByUserId, getUserById, getBallotsForVote, log: guildLog };
}

/** What `applyOutcome` took back from a fake or denied find. */
export interface RevertedRewards {
    seedsReverted: number;
    xpReverted: number;
    revoked: Badge[];
}

/**
 * Reports a vote ruled fake: to the finder's macro channel when `REPORT_FAKE_FINDS` is on, and always
 * to the log channel. Once per vote - a later flip (fake -> deny) posts nothing more. Never throws.
 */
export async function reportFakeFind(
    client: BotClient,
    vote: BiomeVoteRow,
    reverted: RevertedRewards,
    deps: FakeFindDeps = defaultFakeFindDeps(),
): Promise<void> {
    if (vote.status !== VoteStatus.COMMUNITY_FAKE && vote.status !== VoteStatus.ADMIN_DENIED) return;
    try {
        if (!(await deps.markFakeReported(vote.id))) return;

        const ballots = await deps.getBallotsForVote(vote.id);
        const real = ballots.filter((b) => b.choice === VoteChoice.REAL).length;
        const finderDiscordId = vote.finder_discord_id ?? (await deps.getUserById(vote.finder_user_id))?.discord_user_id ?? "";
        const input: FakeFindInput = {
            audience: "member",
            biome: vote.biome,
            finderDiscordId,
            at: vote.created_at,
            status: vote.status,
            decidedBy: vote.decided_by,
            tally: { real, fake: ballots.length - real },
            seedsReverted: reverted.seedsReverted,
            xpReverted: reverted.xpReverted,
            revokedBadge: reverted.revoked.find((b) => b === vote.biome) ?? reverted.revoked[0] ?? null,
            forwardLink: `https://discord.com/channels/${vote.guild_id}/${vote.channel_id}/${vote.message_id}`,
        };

        if (await deps.isFlagEnabled(vote.guild_id, "REPORT_FAKE_FINDS")) {
            const macroChannel = await deps.getMacroChannelByUserId(vote.finder_user_id);
            const channel = macroChannel ? await client.channels.fetch(macroChannel.channel_id).catch(() => null) : null;
            if (channel && !channel.isDMBased() && channel.isTextBased()) {
                await channel
                    .send({ flags: MessageFlags.IsComponentsV2, components: [buildFakeFindContainer(input)], allowedMentions: NO_PINGS })
                    .catch((err) => logger.warn("Could not post the fake-find report", { voteId: vote.id, error: String(err) }));
            }
        }

        await deps.log(client, vote.guild_id, {
            kind: "fake",
            title: "❌ Fake find",
            body: buildFakeFindBody({ ...input, audience: "log" }),
            footer: fakeFindFooter(input.forwardLink),
        });
    } catch (err) {
        logger.error(err instanceof Error ? err : new Error(String(err)), { voteId: vote.id });
    }
}
